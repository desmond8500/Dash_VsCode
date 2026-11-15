package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

var appVersion = "1.1.0"

type App struct {
	store    *Store
	token    string
	dataDir  string
	hub      *Hub
	sessions *Sessions
	handlers map[string]func(json.RawMessage) (any, error)
	quit     chan struct{}
	quitOnce sync.Once
	updater  *Updater
	restart  bool
	port     int
}

type apiError struct {
	Status int
	Msg    string
}

func (e *apiError) Error() string { return e.Msg }

func badRequest(format string, a ...any) error {
	return &apiError{400, fmt.Sprintf(format, a...)}
}

func bind[T any](raw json.RawMessage) (T, error) {
	var v T
	if len(raw) == 0 {
		return v, nil
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, badRequest("requête invalide : %v", err)
	}
	return v, nil
}

func (a *App) register(name string, fn func(json.RawMessage) (any, error)) {
	a.handlers[name] = fn
}

func isLocalHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.Trim(strings.ToLower(host), "[]")
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// DNS-rebinding protection: only answer to local host names.
	if !isLocalHost(r.Host) {
		http.Error(w, "hôte refusé", http.StatusForbidden)
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	path := r.URL.Path
	switch {
	case path == "/" || path == "/index.html":
		a.serveIndex(w)
	case path == "/api/ping":
		writeJSON(w, 200, map[string]any{"app": "dashlite", "version": appVersion})
	case path == "/api/events":
		if !a.checkToken(r) {
			http.Error(w, "jeton invalide", 401)
			return
		}
		a.hub.serve(w, r)
	case path == "/api/raw":
		if !a.checkToken(r) {
			http.Error(w, "jeton invalide", 401)
			return
		}
		a.serveRaw(w, r)
	case strings.HasPrefix(path, "/api/"):
		a.serveAPI(w, r, strings.TrimPrefix(path, "/api/"))
	default:
		a.serveStatic(w, path)
	}
}

func (a *App) checkToken(r *http.Request) bool {
	t := r.Header.Get("X-Dash-Token")
	if t == "" {
		t = r.URL.Query().Get("t")
	}
	return t != "" && t == a.token
}

func (a *App) serveIndex(w http.ResponseWriter) {
	data, err := webFS.ReadFile("web/index.html")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	data = bytes.ReplaceAll(data, []byte("__DASH_TOKEN__"), []byte(a.token))
	data = bytes.ReplaceAll(data, []byte("__DASH_VERSION__"), []byte(appVersion))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'")
	w.Write(data)
}

func (a *App) serveStatic(w http.ResponseWriter, path string) {
	name := "web" + path
	data, err := fs.ReadFile(webFS, name)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	ct := mime.TypeByExtension(filepath.Ext(name))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(data)
}

func (a *App) serveRaw(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	p, err := a.store.project(q.Get("p"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	abs, err := p.resolve(q.Get("path"))
	if err != nil {
		http.Error(w, err.Error(), 403)
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(filepath.Ext(abs))
	if ext == ".svg" {
		// never let an SVG run scripts in our origin
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	}
	if ext == ".html" || ext == ".htm" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

func (a *App) serveAPI(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "méthode non autorisée"})
		return
	}
	if !a.checkToken(r) {
		writeJSON(w, 401, map[string]string{"error": "jeton invalide — rechargez la page"})
		return
	}
	if o := r.Header.Get("Origin"); o != "" {
		if !strings.HasPrefix(o, "http://") || !isLocalHost(strings.TrimPrefix(o, "http://")) {
			writeJSON(w, 403, map[string]string{"error": "origine refusée"})
			return
		}
	}
	h, ok := a.handlers[name]
	if !ok {
		writeJSON(w, 404, map[string]string{"error": "action inconnue : " + name})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	res, err := func() (res any, err error) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic in %s: %v", name, rec)
				err = fmt.Errorf("erreur interne : %v", rec)
			}
		}()
		return h(body)
	}()
	if err != nil {
		status := 500
		var ae *apiError
		if errors.As(err, &ae) {
			status = ae.Status
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	if res == nil {
		res = map[string]bool{"ok": true}
	}
	writeJSON(w, 200, res)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
}

// ---------------------------------------------------------------- core API

func (a *App) registerCore() {
	a.register("state", func(json.RawMessage) (any, error) {
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		home, _ := os.UserHomeDir()
		projects := make([]map[string]any, 0, len(a.store.cfg.Projects))
		for _, p := range a.store.cfg.Projects {
			_, err := os.Stat(p.Path)
			_, gerr := os.Stat(filepath.Join(p.Path, ".git"))
			projects = append(projects, map[string]any{
				"id": p.ID, "name": p.Name, "path": p.Path, "todoFile": p.TodoFile,
				"missing": err != nil, "git": gerr == nil,
			})
		}
		return map[string]any{
			"projects": projects,
			"active":   a.store.cfg.Active,
			"settings": a.store.cfg.Settings,
			"version":  appVersion,
			"platform": runtime.GOOS,
			"home":     home,
			"sep":      string(filepath.Separator),
			"dataDir":  a.dataDir,
		}, nil
	})

	a.register("project.add", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ Path, Name string }](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.addProject(req.Path, req.Name)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": p.ID}, nil
	})

	a.register("project.clone", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ URL, Parent, Name string }](raw)
		if err != nil {
			return nil, err
		}
		url := strings.TrimSpace(req.URL)
		if url == "" || strings.HasPrefix(url, "-") {
			return nil, badRequest("URL de dépôt invalide")
		}
		name := strings.TrimSpace(req.Name)
		if name == "" {
			name = strings.TrimSuffix(filepath.Base(strings.TrimRight(strings.ReplaceAll(url, ":", "/"), "/")), ".git")
		}
		if name == "" || strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
			return nil, badRequest("nom de dossier invalide")
		}
		parent := expandHome(req.Parent)
		if st, err := os.Stat(parent); err != nil || !st.IsDir() {
			return nil, badRequest("dossier parent introuvable : %s", parent)
		}
		dest := filepath.Join(parent, name)
		if _, err := os.Stat(dest); err == nil {
			return nil, badRequest("%s existe déjà", dest)
		}
		out, err := runGit(parent, 15*time.Minute, "clone", "--", url, dest)
		if err != nil {
			return nil, &apiError{500, "échec du clonage :\n" + out}
		}
		p, err := a.addProject(dest, "")
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": p.ID, "output": out}, nil
	})

	a.register("project.remove", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ ID string }](raw)
		if err != nil {
			return nil, err
		}
		a.sessions.closeProject(req.ID)
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		list := a.store.cfg.Projects[:0]
		for _, p := range a.store.cfg.Projects {
			if p.ID != req.ID {
				list = append(list, p)
			}
		}
		a.store.cfg.Projects = list
		delete(a.store.cfg.UI, req.ID)
		if a.store.cfg.Active == req.ID {
			a.store.cfg.Active = ""
			if len(list) > 0 {
				a.store.cfg.Active = list[0].ID
			}
		}
		return nil, a.store.saveLocked()
	})

	a.register("project.update", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			ID       string
			Name     *string
			TodoFile *string
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.store.project(req.ID)
		if err != nil {
			return nil, err
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		if req.Name != nil && strings.TrimSpace(*req.Name) != "" {
			p.Name = strings.TrimSpace(*req.Name)
		}
		if req.TodoFile != nil {
			p.TodoFile = strings.TrimSpace(*req.TodoFile)
		}
		return nil, a.store.saveLocked()
	})

	a.register("project.move", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			ID    string
			Delta int
		}](raw)
		if err != nil {
			return nil, err
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		l := a.store.cfg.Projects
		for i, p := range l {
			if p.ID == req.ID {
				j := i + req.Delta
				if j >= 0 && j < len(l) {
					l[i], l[j] = l[j], l[i]
				}
				break
			}
		}
		return nil, a.store.saveLocked()
	})

	a.register("project.activate", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ ID string }](raw)
		if err != nil {
			return nil, err
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		a.store.cfg.Active = req.ID
		return nil, a.store.saveLocked()
	})

	a.register("settings.set", func(raw json.RawMessage) (any, error) {
		req, err := bind[map[string]any](raw)
		if err != nil {
			return nil, err
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		for k, v := range req {
			a.store.cfg.Settings[k] = v
		}
		return nil, a.store.saveLocked()
	})

	a.register("ui.get", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ ID string }](raw)
		if err != nil {
			return nil, err
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		if v, ok := a.store.cfg.UI[req.ID]; ok {
			return v, nil
		}
		return map[string]any{}, nil
	})

	a.register("ui.save", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			ID    string
			State json.RawMessage
		}](raw)
		if err != nil {
			return nil, err
		}
		if len(req.State) > 1<<20 {
			return nil, badRequest("état trop volumineux")
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		a.store.cfg.UI[req.ID] = req.State
		return nil, a.store.saveLocked()
	})

	a.register("quit", func(json.RawMessage) (any, error) {
		go func() {
			time.Sleep(300 * time.Millisecond)
			a.shutdown()
		}()
		return nil, nil
	})
}

func expandHome(p string) string {
	p = strings.TrimSpace(p)
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		home, _ := os.UserHomeDir()
		p = filepath.Join(home, p[1:])
	}
	return filepath.Clean(p)
}

func (a *App) addProject(path, name string) (*Project, error) {
	path = expandHome(path)
	if path == "" || path == "." {
		return nil, badRequest("chemin vide")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return nil, badRequest("dossier introuvable : %s", abs)
	}
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	for _, p := range a.store.cfg.Projects {
		if strings.EqualFold(filepath.Clean(p.Path), abs) {
			a.store.cfg.Active = p.ID
			return p, a.store.saveLocked()
		}
	}
	if strings.TrimSpace(name) == "" {
		name = filepath.Base(abs)
	}
	p := &Project{ID: newID(), Name: strings.TrimSpace(name), Path: abs, Commands: []*Command{}}
	a.store.cfg.Projects = append(a.store.cfg.Projects, p)
	a.store.cfg.Active = p.ID
	return p, a.store.saveLocked()
}

func (a *App) shutdown() {
	a.quitOnce.Do(func() {
		a.sessions.killAll()
		close(a.quit)
	})
}
