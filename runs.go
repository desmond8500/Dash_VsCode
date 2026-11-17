package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// ---------------------------------------------------------------- SSE hub

type Hub struct {
	mu        sync.Mutex
	clients   map[chan []byte]struct{}
	everSeen  bool
	lastEmpty time.Time
}

func newHub() *Hub {
	return &Hub{clients: map[chan []byte]struct{}{}, lastEmpty: time.Now()}
}

func (h *Hub) send(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- data:
		default: // slow client: drop, it resyncs on reconnect
		}
	}
}

func (h *Hub) status() (count int, everSeen bool, since time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients), h.everSeen, time.Since(h.lastEmpty)
}

func (h *Hub) serve(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming non supporté", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	ch := make(chan []byte, 4096)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.everSeen = true
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, ch)
		if len(h.clients) == 0 {
			h.lastEmpty = time.Now()
		}
		h.mu.Unlock()
	}()
	fmt.Fprintf(w, "retry: 1000\n\n")
	fl.Flush()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case data := <-ch:
			w.Write([]byte("data: "))
			w.Write(data)
			w.Write([]byte("\n\n"))
			// coalesce whatever is already queued
			for i := 0; i < 256; i++ {
				select {
				case more := <-ch:
					w.Write([]byte("data: "))
					w.Write(more)
					w.Write([]byte("\n\n"))
					continue
				default:
				}
				break
			}
			fl.Flush()
		case <-ping.C:
			w.Write([]byte(": ping\n\n"))
			fl.Flush()
		}
	}
}

// ---------------------------------------------------------------- sessions

const bufCap = 1 << 20

type Session struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	Name    string `json:"name"`
	Kind    string `json:"kind"` // "terminal" | "command"
	Command string `json:"command"`
	Cwd     string `json:"cwd"` // absolute
	Running bool   `json:"running"`
	Code    *int   `json:"code"`
	Started int64  `json:"started"`
	Ended   int64  `json:"ended"`
	SSH     string `json:"ssh,omitempty"` // saved SSH connection of this session
	Tty     bool   `json:"tty,omitempty"` // the process has a (remote) terminal that echoes input

	Args []string `json:"-"` // run directly instead of through the shell
	Env  []string `json:"-"` // added to the environment

	mu      sync.Mutex
	buf     []byte
	pending []byte
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	gen     int
	created int64
}

type Sessions struct {
	mu   sync.Mutex
	list map[string]*Session
	hub  *Hub
}

func newSessions(h *Hub) *Sessions {
	return &Sessions{list: map[string]*Session{}, hub: h}
}

func (ss *Sessions) get(id string) (*Session, error) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	s, ok := ss.list[id]
	if !ok {
		return nil, &apiError{404, "session introuvable"}
	}
	return s, nil
}

func (ss *Sessions) add(s *Session) {
	ss.mu.Lock()
	s.created = time.Now().UnixNano()
	ss.list[s.ID] = s
	ss.mu.Unlock()
	ss.hub.send(map[string]any{"t": "sessions", "p": s.Project})
}

type sessWriter struct {
	ss *Sessions
	s  *Session
}

func (w sessWriter) Write(b []byte) (int, error) {
	w.ss.output(w.s, b)
	return len(b), nil
}

func (ss *Sessions) output(s *Session, b []byte) {
	s.mu.Lock()
	data := append(s.pending, b...)
	// keep an incomplete trailing UTF-8 sequence for the next write
	cut := len(data)
	for i := 1; i <= 3 && i <= len(data); i++ {
		c := data[len(data)-i]
		if utf8.RuneStart(c) {
			if !utf8.FullRune(data[len(data)-i:]) {
				cut = len(data) - i
			}
			break
		}
	}
	s.pending = append([]byte(nil), data[cut:]...)
	chunk := data[:cut]
	if len(chunk) == 0 {
		s.mu.Unlock()
		return
	}
	text := strings.ToValidUTF8(string(chunk), "�")
	s.buf = append(s.buf, text...)
	if len(s.buf) > bufCap {
		drop := len(s.buf) - bufCap*3/4
		for drop < len(s.buf) && !utf8.RuneStart(s.buf[drop]) {
			drop++
		}
		s.buf = append([]byte(nil), s.buf[drop:]...)
	}
	s.mu.Unlock()
	ss.hub.send(map[string]any{"t": "out", "id": s.ID, "d": text})
}

func (ss *Sessions) note(s *Session, msg string) {
	ss.output(s, []byte(msg))
}

func childEnv() []string {
	env := os.Environ()
	extra := map[string]string{
		"TERM":                "xterm-256color",
		"FORCE_COLOR":         "1",
		"CLICOLOR_FORCE":      "1",
		"GIT_TERMINAL_PROMPT": "0",
		"PYTHONUNBUFFERED":    "1",
		"PYTHONIOENCODING":    "utf-8",
	}
	out := env[:0:0]
	for _, kv := range env {
		k := kv
		if i := strings.IndexByte(kv, '='); i > 0 {
			k = kv[:i]
		}
		if _, ok := extra[k]; ok {
			continue
		}
		out = append(out, kv)
	}
	for k, v := range extra {
		out = append(out, k+"="+v)
	}
	return out
}

func (ss *Sessions) start(s *Session, line string) error {
	s.mu.Lock()
	if s.Running {
		s.mu.Unlock()
		return errors.New("un processus tourne déjà dans cette session")
	}
	if st, err := os.Stat(s.Cwd); err != nil || !st.IsDir() {
		s.mu.Unlock()
		return fmt.Errorf("dossier introuvable : %s", s.Cwd)
	}
	var cmd *exec.Cmd
	if len(s.Args) > 0 {
		cmd = exec.Command(s.Args[0], s.Args[1:]...)
	} else {
		cmd = shellCommand(line)
	}
	cmd.Dir = s.Cwd
	cmd.Env = append(childEnv(), s.Env...)
	cmd.WaitDelay = 5 * time.Second
	w := sessWriter{ss, s}
	cmd.Stdout = w
	cmd.Stderr = w
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	prepareCmd(cmd)
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		return err
	}
	s.gen++
	gen := s.gen
	s.cmd = cmd
	s.stdin = stdin
	s.Running = true
	s.Code = nil
	s.Started = time.Now().UnixMilli()
	s.Ended = 0
	s.mu.Unlock()
	ss.hub.send(map[string]any{"t": "status", "id": s.ID, "running": true})

	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				code = -1
			}
		}
		s.mu.Lock()
		if s.gen != gen {
			s.mu.Unlock()
			return
		}
		s.Running = false
		s.Code = &code
		s.Ended = time.Now().UnixMilli()
		s.cmd = nil
		s.stdin = nil
		dur := time.Duration(s.Ended-s.Started) * time.Millisecond
		kind := s.Kind
		s.mu.Unlock()
		if kind == "command" {
			if code == 0 {
				ss.note(s, fmt.Sprintf("\r\n\x1b[32m✓ Terminé en %s\x1b[0m\r\n", roundDur(dur)))
			} else {
				ss.note(s, fmt.Sprintf("\r\n\x1b[31m✗ Code de sortie %d (%s)\x1b[0m\r\n", code, roundDur(dur)))
			}
		} else if code != 0 {
			ss.note(s, fmt.Sprintf("\x1b[90m[code %d]\x1b[0m\r\n", code))
		}
		ss.hub.send(map[string]any{"t": "status", "id": s.ID, "running": false, "code": code})
	}()
	return nil
}

func roundDur(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%d ms", d.Milliseconds())
	}
	if d < time.Minute {
		return fmt.Sprintf("%.1f s", d.Seconds())
	}
	return d.Round(time.Second).String()
}

func (ss *Sessions) kill(s *Session) {
	s.mu.Lock()
	cmd := s.cmd
	running := s.Running
	s.mu.Unlock()
	if running && cmd != nil && cmd.Process != nil {
		killTree(cmd)
	}
}

func (ss *Sessions) remove(id string) {
	ss.mu.Lock()
	s, ok := ss.list[id]
	delete(ss.list, id)
	ss.mu.Unlock()
	if ok {
		ss.kill(s)
		ss.hub.send(map[string]any{"t": "sessions", "p": s.Project})
	}
}

func (ss *Sessions) closeProject(pid string) {
	ss.mu.Lock()
	var ids []string
	for id, s := range ss.list {
		if s.Project == pid {
			ids = append(ids, id)
		}
	}
	ss.mu.Unlock()
	for _, id := range ids {
		ss.remove(id)
	}
}

func (ss *Sessions) killAll() {
	ss.mu.Lock()
	var all []*Session
	for _, s := range ss.list {
		all = append(all, s)
	}
	ss.mu.Unlock()
	for _, s := range all {
		ss.kill(s)
	}
}

func (s *Session) snapshot(withBuf bool) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := map[string]any{
		"id": s.ID, "project": s.Project, "name": s.Name, "kind": s.Kind,
		"command": s.Command, "cwd": s.Cwd, "running": s.Running, "code": s.Code,
		"started": s.Started, "ended": s.Ended,
	}
	if s.SSH != "" {
		m["ssh"] = s.SSH
	}
	if s.Tty {
		m["tty"] = true
	}
	if withBuf {
		m["buffer"] = string(s.buf)
	}
	return m
}

// ---------------------------------------------------------------- API

func (a *App) registerRuns() {
	ss := a.sessions

	a.register("run.list", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P string `json:"p"`
		}](raw)
		if err != nil {
			return nil, err
		}
		ss.mu.Lock()
		var list []*Session
		for _, s := range ss.list {
			if s.Project == req.P {
				list = append(list, s)
			}
		}
		ss.mu.Unlock()
		sort.Slice(list, func(i, j int) bool {
			if (list[i].Kind == "terminal") != (list[j].Kind == "terminal") {
				return list[i].Kind == "terminal"
			}
			return list[i].created < list[j].created
		})
		out := make([]map[string]any, 0, len(list))
		for _, s := range list {
			out = append(out, s.snapshot(true))
		}
		return out, nil
	})

	a.register("run.get", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ ID string }](raw)
		if err != nil {
			return nil, err
		}
		s, err := ss.get(req.ID)
		if err != nil {
			return nil, err
		}
		return s.snapshot(true), nil
	})

	a.register("run.start", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P       string `json:"p"`
			Name    string `json:"name"`
			Command string `json:"command"`
			Cwd     string `json:"cwd"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(req.Command) == "" {
			return nil, badRequest("commande vide")
		}
		cwd, err := p.resolve(req.Cwd)
		if err != nil {
			return nil, badRequest("%v", err)
		}
		name := strings.TrimSpace(req.Name)
		if name == "" {
			name = req.Command
		}
		// reuse an idle session that ran the same command
		ss.mu.Lock()
		var s *Session
		for _, x := range ss.list {
			if x.Project == p.ID && x.Kind == "command" && x.Command == req.Command && x.Cwd == cwd {
				s = x
				break
			}
		}
		ss.mu.Unlock()
		if s != nil {
			s.mu.Lock()
			running := s.Running
			s.mu.Unlock()
			if running {
				return s.snapshot(false), nil
			}
		} else {
			s = &Session{ID: newID(), Project: p.ID, Name: name, Kind: "command", Command: req.Command, Cwd: cwd}
			ss.add(s)
		}
		ss.note(s, fmt.Sprintf("\x1b[36m▶ %s\x1b[0m  \x1b[90m%s\x1b[0m\r\n", req.Command, cwd))
		if err := ss.start(s, req.Command); err != nil {
			ss.note(s, "\x1b[31m"+err.Error()+"\x1b[0m\r\n")
			return nil, err
		}
		return s.snapshot(false), nil
	})

	a.register("run.restart", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ ID string }](raw)
		if err != nil {
			return nil, err
		}
		s, err := ss.get(req.ID)
		if err != nil {
			return nil, err
		}
		if s.Kind != "command" {
			return nil, badRequest("seules les commandes peuvent être relancées")
		}
		ss.kill(s)
		for i := 0; i < 50; i++ {
			s.mu.Lock()
			r := s.Running
			s.mu.Unlock()
			if !r {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		s.mu.Lock()
		s.buf = nil
		s.mu.Unlock()
		ss.hub.send(map[string]any{"t": "clear", "id": s.ID})
		ss.note(s, fmt.Sprintf("\x1b[36m▶ %s\x1b[0m  \x1b[90m%s\x1b[0m\r\n", s.Command, s.Cwd))
		if err := ss.start(s, s.Command); err != nil {
			return nil, err
		}
		return nil, nil
	})

	a.register("run.kill", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ ID string }](raw)
		if err != nil {
			return nil, err
		}
		s, err := ss.get(req.ID)
		if err != nil {
			return nil, err
		}
		ss.kill(s)
		return nil, nil
	})

	a.register("run.close", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ ID string }](raw)
		if err != nil {
			return nil, err
		}
		ss.remove(req.ID)
		return nil, nil
	})

	a.register("run.clear", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ ID string }](raw)
		if err != nil {
			return nil, err
		}
		s, err := ss.get(req.ID)
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		s.buf = nil
		s.mu.Unlock()
		return nil, nil
	})

	a.register("run.input", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			ID   string `json:"id"`
			Data string `json:"data"`
		}](raw)
		if err != nil {
			return nil, err
		}
		s, err := ss.get(req.ID)
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		in, tty := s.stdin, s.Tty
		s.mu.Unlock()
		if in == nil {
			return nil, badRequest("aucun processus en attente")
		}
		if !tty { // a remote terminal echoes the input itself
			ss.output(s, []byte(strings.ReplaceAll(req.Data, "\n", "\r\n")))
		}
		_, err = io.WriteString(in, req.Data)
		return nil, err
	})

	a.register("term.open", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P   string `json:"p"`
			New bool   `json:"new"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		n := 0
		if !req.New {
			ss.mu.Lock()
			for _, x := range ss.list {
				if x.Project == p.ID && x.Kind == "terminal" {
					ss.mu.Unlock()
					return x.snapshot(true), nil
				}
			}
			ss.mu.Unlock()
		} else {
			ss.mu.Lock()
			for _, x := range ss.list {
				if x.Project == p.ID && x.Kind == "terminal" {
					n++
				}
			}
			ss.mu.Unlock()
		}
		name := "Terminal"
		if n > 0 {
			name = fmt.Sprintf("Terminal %d", n+1)
		}
		s := &Session{ID: newID(), Project: p.ID, Name: name, Kind: "terminal", Cwd: filepath.Clean(p.Path)}
		ss.add(s)
		return s.snapshot(true), nil
	})

	a.register("term.exec", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			ID   string `json:"id"`
			Line string `json:"line"`
		}](raw)
		if err != nil {
			return nil, err
		}
		s, err := ss.get(req.ID)
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		running, in, cwd := s.Running, s.stdin, s.Cwd
		s.mu.Unlock()
		if running && in != nil {
			ss.output(s, []byte(req.Line+"\r\n"))
			_, err := io.WriteString(in, req.Line+"\n")
			return map[string]any{"cwd": cwd}, err
		}
		line := strings.TrimSpace(req.Line)
		ss.note(s, fmt.Sprintf("\x1b[1;34m%s\x1b[0m \x1b[1m❯\x1b[0m %s\r\n", shortPath(cwd), line))
		if line == "" {
			return map[string]any{"cwd": cwd}, nil
		}
		if target, ok := parseCd(line); ok {
			var dest string
			switch {
			case target == "" || target == "~":
				p, err := a.proj(s.Project)
				if err == nil && target == "" {
					dest = p.Path
				} else {
					dest, _ = os.UserHomeDir()
				}
			case filepath.IsAbs(target) || (runtime.GOOS == "windows" && len(target) >= 2 && target[1] == ':'):
				dest = target
			default:
				dest = filepath.Join(cwd, expandHome(target))
				if strings.HasPrefix(target, "~") {
					dest = expandHome(target)
				}
			}
			dest = filepath.Clean(dest)
			if st, err := os.Stat(dest); err != nil || !st.IsDir() {
				ss.note(s, "\x1b[31mcd : dossier introuvable : "+target+"\x1b[0m\r\n")
			} else {
				s.mu.Lock()
				s.Cwd = dest
				s.mu.Unlock()
				cwd = dest
				ss.hub.send(map[string]any{"t": "cwd", "id": s.ID, "cwd": dest})
			}
			return map[string]any{"cwd": cwd}, nil
		}
		s.mu.Lock()
		s.Command = line
		s.mu.Unlock()
		if err := ss.start(s, line); err != nil {
			ss.note(s, "\x1b[31m"+err.Error()+"\x1b[0m\r\n")
		}
		return map[string]any{"cwd": cwd}, nil
	})
}

func parseCd(line string) (string, bool) {
	if line == "cd" {
		return "", true
	}
	if runtime.GOOS == "windows" && (strings.HasPrefix(strings.ToLower(line), "cd/") || strings.HasPrefix(strings.ToLower(line), "chdir ")) {
		line = "cd " + strings.TrimPrefix(strings.TrimPrefix(line, "chdir "), "cd")
	}
	if !strings.HasPrefix(line, "cd ") {
		return "", false
	}
	// don't intercept compound commands like "cd x && npm i"
	if strings.ContainsAny(line, "&|;") {
		return "", false
	}
	t := strings.TrimSpace(line[3:])
	if runtime.GOOS == "windows" && strings.HasPrefix(strings.ToLower(t), "/d ") {
		t = strings.TrimSpace(t[3:])
	}
	t = strings.Trim(t, `"'`)
	return t, true
}

func shortPath(p string) string {
	home, _ := os.UserHomeDir()
	if home != "" && within(home, p) {
		r, _ := filepath.Rel(home, p)
		if r == "." {
			return "~"
		}
		return "~" + string(filepath.Separator) + r
	}
	return p
}
