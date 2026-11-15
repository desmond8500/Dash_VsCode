package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Repository whose GitHub Releases provide updates (override with -ldflags "-X main.updateRepo=owner/name").
var updateRepo = "desmond8500/Dash_VsCode"

type release struct {
	Version   string `json:"version"`
	Tag       string `json:"tag"`
	URL       string `json:"url"`
	Notes     string `json:"notes"`
	Published string `json:"published"`
	assetURL  string
	sumsURL   string
}

type Updater struct {
	app       *App
	mu        sync.Mutex
	latest    *release
	checkedAt time.Time
	state     string // idle | checking | downloading | ready | error
	progress  float64
	err       string
	reason    string // why automatic install is impossible
	busy      bool
	ready     string // version already installed, waiting for a restart
}

func assetName() string {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "windows/amd64":
		return "DashLite-Windows-x64.exe"
	case "windows/arm64":
		return "DashLite-Windows-ARM64.exe"
	case "linux/amd64":
		return "DashLite-Linux-x64.tar.gz"
	case "linux/arm64":
		return "DashLite-Linux-ARM64.tar.gz"
	}
	return ""
}

func releaseAPI() string {
	if v := os.Getenv("DASHLITE_UPDATE_URL"); v != "" { // used for tests
		return v
	}
	return "https://api.github.com/repos/" + updateRepo + "/releases/latest"
}

func parseVersion(s string) [3]int {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexAny(s, "-+ "); i >= 0 {
		s = s[:i]
	}
	var v [3]int
	for i, p := range strings.SplitN(s, ".", 3) {
		v[i], _ = strconv.Atoi(p)
	}
	return v
}

func newer(a, b string) bool { // a > b
	x, y := parseVersion(a), parseVersion(b)
	for i := 0; i < 3; i++ {
		if x[i] != y[i] {
			return x[i] > y[i]
		}
	}
	return false
}

func currentExe() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return exe, nil
}

var httpClient = &http.Client{Timeout: 10 * time.Minute}

func httpGet(url string) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "DashLite/"+appVersion)
	req.Header.Set("Accept", "application/vnd.github+json, application/octet-stream;q=0.9, */*;q=0.5")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		if resp.StatusCode == 404 {
			return nil, errors.New("aucune version publiée pour le moment")
		}
		return nil, fmt.Errorf("réponse HTTP %d", resp.StatusCode)
	}
	return resp, nil
}

func (u *Updater) status() map[string]any {
	u.mu.Lock()
	defer u.mu.Unlock()
	m := map[string]any{
		"current":  appVersion,
		"state":    u.state,
		"progress": u.progress,
		"error":    u.err,
		"reason":   u.reason,
		"mode":     u.mode(),
		"platform": runtime.GOOS,
		"repo":     updateRepo,
		"ready":    u.ready,
	}
	if !u.checkedAt.IsZero() {
		m["checkedAt"] = u.checkedAt.UnixMilli()
	}
	if u.latest != nil {
		m["latest"] = u.latest
		m["available"] = newer(u.latest.Version, appVersion)
		m["canInstall"] = u.reason == "" && u.latest.assetURL != "" && u.latest.sumsURL != ""
	}
	return m
}

func (u *Updater) mode() string {
	u.app.store.mu.Lock()
	defer u.app.store.mu.Unlock()
	if v, ok := u.app.store.cfg.Settings["updateMode"].(string); ok && (v == "auto" || v == "notify" || v == "off") {
		return v
	}
	return "auto"
}

func (u *Updater) broadcast() {
	st := u.status()
	st["t"] = "update"
	u.app.hub.send(st)
}

func (u *Updater) check() error {
	u.mu.Lock()
	if u.busy {
		u.mu.Unlock()
		return nil
	}
	u.mu.Unlock()
	resp, err := httpGet(releaseAPI())
	if err != nil {
		u.mu.Lock()
		u.err = "vérification impossible : " + err.Error()
		u.checkedAt = time.Now()
		u.mu.Unlock()
		return err
	}
	defer resp.Body.Close()
	var gh struct {
		TagName     string `json:"tag_name"`
		HTMLURL     string `json:"html_url"`
		Body        string `json:"body"`
		PublishedAt string `json:"published_at"`
		Draft       bool   `json:"draft"`
		Prerelease  bool   `json:"prerelease"`
		Assets      []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&gh); err != nil {
		return err
	}
	r := &release{Version: strings.TrimPrefix(gh.TagName, "v"), Tag: gh.TagName, URL: gh.HTMLURL, Notes: gh.Body, Published: gh.PublishedAt}
	want := assetName()
	for _, a := range gh.Assets {
		if a.Name == want {
			r.assetURL = a.URL
		}
		if a.Name == "SHA256SUMS" || a.Name == "SHA256SUMS.txt" {
			r.sumsURL = a.URL
		}
	}
	reason := ""
	switch {
	case want == "":
		reason = "mise à jour automatique non disponible sur ce système"
	case r.assetURL == "":
		reason = "cette version ne contient pas de fichier pour votre système (" + want + ")"
	case r.sumsURL == "":
		reason = "cette version ne fournit pas de somme de contrôle (SHA256SUMS)"
	default:
		if exe, err := currentExe(); err != nil {
			reason = "emplacement de l'application inconnu"
		} else if f, err := os.CreateTemp(filepath.Dir(exe), ".dashlite-w-*"); err != nil {
			reason = "le dossier de l'application n'est pas modifiable (" + filepath.Dir(exe) + ")"
		} else {
			f.Close()
			os.Remove(f.Name())
		}
	}
	u.mu.Lock()
	u.latest = r
	u.checkedAt = time.Now()
	u.err = ""
	u.reason = reason
	if u.state == "" || u.state == "error" {
		u.state = "idle"
	}
	u.mu.Unlock()
	return nil
}

// install downloads the release for this platform, verifies its SHA-256 and
// puts it in place of the running executable. The new version runs at the next start.
func (u *Updater) install() error {
	u.mu.Lock()
	r := u.latest
	if u.busy {
		u.mu.Unlock()
		return errors.New("mise à jour déjà en cours")
	}
	if r == nil || !newer(r.Version, appVersion) {
		u.mu.Unlock()
		return errors.New("aucune nouvelle version")
	}
	if u.reason != "" || r.assetURL == "" || r.sumsURL == "" {
		reason := u.reason
		u.mu.Unlock()
		return errors.New(reason)
	}
	if u.ready == r.Version {
		u.mu.Unlock()
		return nil
	}
	u.busy = true
	u.state = "downloading"
	u.progress = 0
	u.err = ""
	u.mu.Unlock()
	u.broadcast()

	err := u.doInstall(r)

	u.mu.Lock()
	u.busy = false
	if err != nil {
		u.state = "error"
		u.err = err.Error()
	} else {
		u.state = "ready"
		u.ready = r.Version
		u.progress = 1
	}
	u.mu.Unlock()
	u.broadcast()
	if err != nil {
		log.Printf("mise à jour : %v", err)
	} else {
		log.Printf("mise à jour %s installée (active au prochain démarrage)", r.Version)
	}
	return err
}

func (u *Updater) doInstall(r *release) error {
	exe, err := currentExe()
	if err != nil {
		return err
	}
	dir := filepath.Dir(exe)
	name := assetName()

	// expected checksum
	resp, err := httpGet(r.sumsURL)
	if err != nil {
		return fmt.Errorf("téléchargement de SHA256SUMS : %w", err)
	}
	sums, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	want := ""
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return errors.New("somme de contrôle introuvable pour " + name)
	}

	// download
	resp, err = httpGet(r.assetURL)
	if err != nil {
		return fmt.Errorf("téléchargement : %w", err)
	}
	defer resp.Body.Close()
	dl, err := os.CreateTemp(dir, ".dashlite-dl-*")
	if err != nil {
		return err
	}
	dlPath := dl.Name()
	defer os.Remove(dlPath)
	h := sha256.New()
	total := resp.ContentLength
	var done int64
	buf := make([]byte, 64*1024)
	lastSend := time.Now()
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := dl.Write(buf[:n]); werr != nil {
				dl.Close()
				return werr
			}
			h.Write(buf[:n])
			done += int64(n)
			if total > 0 && time.Since(lastSend) > 300*time.Millisecond {
				u.mu.Lock()
				u.progress = float64(done) / float64(total)
				u.mu.Unlock()
				u.broadcast()
				lastSend = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			dl.Close()
			return fmt.Errorf("téléchargement interrompu : %w", rerr)
		}
	}
	dl.Close()
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return errors.New("somme de contrôle invalide : fichier corrompu ou modifié, mise à jour annulée")
	}

	// unpack (Linux archives contain the "DashLite" binary)
	newPath := dlPath
	if strings.HasSuffix(name, ".tar.gz") {
		newPath, err = extractBinary(dlPath, dir)
		if err != nil {
			return err
		}
		defer os.Remove(newPath)
	}
	if err := os.Chmod(newPath, 0o755); err != nil {
		return err
	}
	return replaceExe(exe, newPath)
}

func extractBinary(archive, dir string) (string, error) {
	f, err := os.Open(archive)
	if err != nil {
		return "", err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	tr := tar.NewReader(gz)
	for {
		hd, err := tr.Next()
		if err == io.EOF {
			return "", errors.New("archive sans exécutable DashLite")
		}
		if err != nil {
			return "", err
		}
		if filepath.Base(hd.Name) != "DashLite" || hd.Typeflag != tar.TypeReg {
			continue
		}
		out, err := os.CreateTemp(dir, ".dashlite-new-*")
		if err != nil {
			return "", err
		}
		if _, err := io.Copy(out, io.LimitReader(tr, 200<<20)); err != nil {
			out.Close()
			os.Remove(out.Name())
			return "", err
		}
		out.Close()
		return out.Name(), nil
	}
}

// replaceExe swaps the executable. Linux allows renaming over a running binary;
// Windows allows renaming a running .exe out of the way (cleaned at next start).
func replaceExe(exe, newPath string) error {
	if runtime.GOOS == "windows" {
		old := exe + ".old"
		os.Remove(old)
		if err := renameRetry(exe, old); err != nil {
			return fmt.Errorf("impossible de remplacer l'exécutable : %w", err)
		}
		if err := renameRetry(newPath, exe); err != nil {
			os.Rename(old, exe)
			return fmt.Errorf("impossible d'installer la nouvelle version : %w", err)
		}
		return nil
	}
	if err := os.Rename(newPath, exe); err != nil {
		return fmt.Errorf("impossible de remplacer l'exécutable : %w", err)
	}
	return nil
}

// renameRetry tolerates short locks (antivirus scanning a fresh download on Windows).
func renameRetry(from, to string) error {
	var err error
	for i := 0; i < 10; i++ {
		if err = os.Rename(from, to); err == nil {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return err
}

// cleanupOldBinaries removes leftovers from a previous update.
func cleanupOldBinaries() {
	exe, err := currentExe()
	if err != nil {
		return
	}
	dir := filepath.Dir(exe)
	go func() {
		for i := 0; i < 10; i++ {
			err := os.Remove(exe + ".old")
			if err == nil || errors.Is(err, os.ErrNotExist) {
				break
			}
			time.Sleep(time.Second) // the previous process may still be exiting
		}
		matches, _ := filepath.Glob(filepath.Join(dir, ".dashlite-*"))
		for _, m := range matches {
			if st, err := os.Stat(m); err == nil && time.Since(st.ModTime()) > time.Hour {
				os.Remove(m)
			}
		}
	}()
}

func (u *Updater) loop() {
	time.Sleep(8 * time.Second)
	for {
		if u.mode() != "off" {
			if err := u.check(); err == nil {
				st := u.status()
				if st["available"] == true {
					if u.mode() == "auto" && st["canInstall"] == true {
						u.install()
					} else {
						u.broadcast()
					}
				}
			}
		}
		time.Sleep(6 * time.Hour)
	}
}

// restart starts the (updated) executable on the same port, then quits.
func (a *App) restartArgs() []string {
	var args []string
	in := os.Args[1:]
	for i := 0; i < len(in); i++ {
		x := in[i]
		switch {
		case x == "-restarted" || x == "--restarted":
		case x == "-port" || x == "--port":
			i++
		case strings.HasPrefix(x, "-port=") || strings.HasPrefix(x, "--port="):
		default:
			args = append(args, x)
		}
	}
	return append(args, "-port", strconv.Itoa(a.port), "-restarted")
}

func (a *App) spawnRestart() error {
	exe, err := currentExe()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, a.restartArgs()...)
	prepareCmd(cmd)
	return cmd.Start()
}

func (a *App) registerUpdate() {
	u := a.updater
	a.register("update.status", func(json.RawMessage) (any, error) { return u.status(), nil })
	a.register("update.check", func(json.RawMessage) (any, error) {
		if err := u.check(); err != nil {
			return nil, &apiError{502, "Vérification impossible : " + err.Error()}
		}
		return u.status(), nil
	})
	a.register("update.install", func(json.RawMessage) (any, error) {
		go u.install()
		return nil, nil
	})
	a.register("update.restart", func(json.RawMessage) (any, error) {
		a.restart = true
		go func() {
			time.Sleep(300 * time.Millisecond)
			a.shutdown()
		}()
		return nil, nil
	})
}
