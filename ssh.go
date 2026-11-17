package main

// SSH connections: saved connection details, connection in a terminal session and
// password / host-key prompts answered from the interface.
//
// ssh runs without a local terminal (Dash uses pipes), so it cannot read a password from
// the keyboard. It asks SSH_ASKPASS instead: that program is DashLite itself, started in
// "askpass" mode (see runAskpass), which forwards the question to this server; the
// interface shows a dialog and the answer goes back to ssh. Passwords are never stored.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type SSHConn struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Host    string `json:"host"`
	Port    int    `json:"port,omitempty"`
	User    string `json:"user,omitempty"`
	Key     string `json:"key,omitempty"`     // identity file
	Dir     string `json:"dir,omitempty"`     // remote folder opened on connection
	Jump    string `json:"jump,omitempty"`    // ProxyJump
	Options string `json:"options,omitempty"` // extra ssh arguments
}

func (c *SSHConn) validate() error {
	c.Name = strings.TrimSpace(c.Name)
	c.Host = strings.TrimSpace(c.Host)
	c.User = strings.TrimSpace(c.User)
	c.Key = strings.TrimSpace(c.Key)
	c.Dir = strings.TrimSpace(c.Dir)
	c.Jump = strings.TrimSpace(c.Jump)
	c.Options = strings.TrimSpace(c.Options)
	if c.Host == "" {
		return errors.New("hôte manquant")
	}
	// these values become ssh arguments: refuse anything that could be read as an option
	bad := func(v string) bool { return strings.HasPrefix(v, "-") || strings.ContainsAny(v, " \t\r\n") }
	if bad(c.Host) {
		return errors.New("hôte invalide")
	}
	if c.User != "" && (bad(c.User) || strings.Contains(c.User, "@")) {
		return errors.New("utilisateur invalide")
	}
	if c.Jump != "" && bad(c.Jump) {
		return errors.New("rebond (ProxyJump) invalide")
	}
	if c.Port < 0 || c.Port > 65535 {
		return errors.New("port invalide")
	}
	if strings.ContainsAny(c.Dir, "\r\n") {
		return errors.New("dossier distant invalide")
	}
	if c.Name == "" {
		c.Name = c.Host
		if c.User != "" {
			c.Name = c.User + "@" + c.Host
		}
	}
	return nil
}

// quote for the remote POSIX shell, keeping a leading ~ so that it still expands
func remoteQuote(d string) string {
	sq := func(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
	switch {
	case d == "~":
		return "~"
	case strings.HasPrefix(d, "~/"):
		return "~/" + sq(d[2:])
	}
	return sq(d)
}

func (c *SSHConn) args() []string {
	// -tt: a remote terminal even though ssh itself has none (prompt, colors, Ctrl+C, sudo)
	args := []string{"-tt", "-o", "ServerAliveInterval=30"}
	if c.Port > 0 && c.Port != 22 {
		args = append(args, "-p", strconv.Itoa(c.Port))
	}
	if c.Key != "" {
		args = append(args, "-i", expandHome(c.Key))
	}
	if c.Jump != "" {
		args = append(args, "-J", c.Jump)
	}
	args = append(args, splitArgs(c.Options)...)
	target := c.Host
	if c.User != "" {
		target = c.User + "@" + c.Host
	}
	args = append(args, target)
	if c.Dir != "" {
		args = append(args, "cd "+remoteQuote(c.Dir)+` && exec "$SHELL" -l`)
	}
	return args
}

// splitArgs splits on spaces, honouring simple "double" and 'single' quotes.
func splitArgs(s string) []string {
	var out []string
	var cur strings.Builder
	var q rune
	has := false
	for _, r := range s {
		switch {
		case q != 0 && r == q:
			q = 0
		case q != 0:
			cur.WriteRune(r)
		case r == '"' || r == '\'':
			q, has = r, true
		case r == ' ' || r == '\t':
			if has || cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
				has = false
			}
		default:
			cur.WriteRune(r)
		}
	}
	if has || cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func displayCommand(args []string) string {
	parts := make([]string, len(args))
	for i, a := range args {
		if a == "" || strings.ContainsAny(a, " \t\"'$&|;<>") {
			a = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
		parts[i] = a
	}
	return strings.Join(parts, " ")
}

// ---------------------------------------------------------------- ~/.ssh/config

type sshHost struct {
	Alias    string `json:"alias"`
	HostName string `json:"hostname,omitempty"`
	User     string `json:"user,omitempty"`
	Port     string `json:"port,omitempty"`
}

// sshConfigHosts lists the named hosts of ~/.ssh/config (patterns with * or ? are skipped).
func sshConfigHosts() []sshHost {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	f, err := os.Open(filepath.Join(home, ".ssh", "config"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []sshHost
	var cur []int // indexes of the hosts of the current block
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val := line, ""
		if i := strings.IndexAny(line, " \t="); i > 0 {
			key, val = line[:i], strings.Trim(strings.TrimSpace(line[i:]), "= \t\"")
		}
		switch strings.ToLower(key) {
		case "host":
			cur = nil
			for _, a := range strings.Fields(val) {
				if strings.ContainsAny(a, "*?!") {
					continue
				}
				cur = append(cur, len(out))
				out = append(out, sshHost{Alias: a})
			}
		case "match":
			cur = nil
		case "hostname":
			for _, i := range cur {
				out[i].HostName = val
			}
		case "user":
			for _, i := range cur {
				out[i].User = val
			}
		case "port":
			for _, i := range cur {
				out[i].Port = val
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- askpass

type askpassReq struct {
	ch chan askpassAnswer
}

type askpassAnswer struct {
	Answer string
	Cancel bool
}

type Askpass struct {
	mu      sync.Mutex
	key     string
	pending map[string]*askpassReq
}

// serveAskpass answers the DashLite process that ssh started as SSH_ASKPASS.
func (a *App) serveAskpass(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.Header.Get("X-Dash-Askpass") != a.askpass.key {
		http.Error(w, "refusé", http.StatusForbidden)
		return
	}
	var req struct {
		Session string `json:"session"`
		Prompt  string `json:"prompt"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		http.Error(w, "requête invalide", http.StatusBadRequest)
		return
	}
	name, project := "SSH", ""
	if s, err := a.sessions.get(req.Session); err == nil {
		name, project = s.Name, s.Project
	} else {
		http.Error(w, "session inconnue", http.StatusForbidden)
		return
	}
	id := newID()
	p := &askpassReq{ch: make(chan askpassAnswer, 1)}
	a.askpass.mu.Lock()
	a.askpass.pending[id] = p
	a.askpass.mu.Unlock()
	defer func() {
		a.askpass.mu.Lock()
		delete(a.askpass.pending, id)
		a.askpass.mu.Unlock()
		a.hub.send(map[string]any{"t": "askpass-done", "ask": id})
	}()
	ask := map[string]any{"t": "askpass", "ask": id, "id": req.Session, "name": name, "project": project, "prompt": req.Prompt}
	a.hub.send(ask)
	// a window opened later (or reloaded) gets the question again
	resend := time.NewTicker(3 * time.Second)
	defer resend.Stop()
	timeout := time.NewTimer(5 * time.Minute)
	defer timeout.Stop()
	for {
		select {
		case ans := <-p.ch:
			writeJSON(w, 200, map[string]any{"answer": ans.Answer, "cancel": ans.Cancel})
			return
		case <-resend.C:
			if n, _, _ := a.hub.status(); n > 0 {
				ask["again"] = true
				a.hub.send(ask)
			}
		case <-timeout.C:
			writeJSON(w, 200, map[string]any{"cancel": true})
			return
		case <-r.Context().Done():
			return
		}
	}
}

// runAskpass is DashLite started by ssh as SSH_ASKPASS: print the answer typed in the interface.
func runAskpass(url string) int {
	body, _ := json.Marshal(map[string]string{
		"session": os.Getenv("DASHLITE_ASKPASS_SESSION"),
		"prompt":  strings.Join(os.Args[1:], " "),
	})
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 1
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Dash-Askpass", os.Getenv("DASHLITE_ASKPASS_KEY"))
	client := &http.Client{Timeout: 6 * time.Minute, Transport: &http.Transport{Proxy: nil}}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "DashLite askpass :", err)
		return 1
	}
	defer resp.Body.Close()
	var ans struct {
		Answer string `json:"answer"`
		Cancel bool   `json:"cancel"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&ans) != nil || ans.Cancel {
		return 1
	}
	fmt.Println(ans.Answer)
	return 0
}

// ---------------------------------------------------------------- API

func (a *App) registerSSH() {
	a.askpass = &Askpass{key: newID() + newID() + newID(), pending: map[string]*askpassReq{}}

	a.register("ssh.list", func(raw json.RawMessage) (any, error) {
		a.store.mu.Lock()
		conns := append([]*SSHConn{}, a.store.cfg.SSH...)
		a.store.mu.Unlock()
		path, err := exec.LookPath("ssh")
		return map[string]any{"conns": conns, "hosts": sshConfigHosts(), "ssh": err == nil, "sshPath": path}, nil
	})

	a.register("ssh.save", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			Conn SSHConn `json:"conn"`
		}](raw)
		if err != nil {
			return nil, err
		}
		c := req.Conn
		if err := c.validate(); err != nil {
			return nil, badRequest("%v", err)
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		if c.ID != "" {
			for i, x := range a.store.cfg.SSH {
				if x.ID == c.ID {
					a.store.cfg.SSH[i] = &c
					return &c, a.store.saveLocked()
				}
			}
		}
		c.ID = newID()
		a.store.cfg.SSH = append(a.store.cfg.SSH, &c)
		return &c, a.store.saveLocked()
	})

	a.register("ssh.delete", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ ID string }](raw)
		if err != nil {
			return nil, err
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		list := a.store.cfg.SSH[:0]
		for _, x := range a.store.cfg.SSH {
			if x.ID != req.ID {
				list = append(list, x)
			}
		}
		a.store.cfg.SSH = list
		return nil, a.store.saveLocked()
	})

	a.register("ssh.move", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			ID    string `json:"id"`
			Delta int    `json:"delta"`
		}](raw)
		if err != nil {
			return nil, err
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		l := a.store.cfg.SSH
		for i, x := range l {
			if x.ID == req.ID {
				j := i + req.Delta
				if j >= 0 && j < len(l) {
					l[i], l[j] = l[j], l[i]
				}
				break
			}
		}
		return nil, a.store.saveLocked()
	})

	a.register("ssh.command", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			Conn SSHConn `json:"conn"`
		}](raw)
		if err != nil {
			return nil, err
		}
		if err := req.Conn.validate(); err != nil {
			return nil, badRequest("%v", err)
		}
		return displayCommand(append([]string{"ssh"}, req.Conn.args()...)), nil
	})

	a.register("ssh.connect", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P     string `json:"p"`
			ID    string `json:"id"`
			Alias string `json:"alias"` // a host of ~/.ssh/config
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		var c SSHConn
		if req.ID != "" {
			a.store.mu.Lock()
			for _, x := range a.store.cfg.SSH {
				if x.ID == req.ID {
					c = *x
				}
			}
			a.store.mu.Unlock()
			if c.ID == "" {
				return nil, badRequest("connexion introuvable")
			}
		} else {
			c = SSHConn{ID: "cfg:" + req.Alias, Name: req.Alias, Host: req.Alias}
		}
		if err := c.validate(); err != nil {
			return nil, badRequest("%v", err)
		}
		sshPath, err := exec.LookPath("ssh")
		if err != nil {
			return nil, badRequest("la commande ssh est introuvable : installez le client OpenSSH")
		}
		exe, _ := os.Executable()
		args := append([]string{sshPath}, c.args()...)
		command := displayCommand(append([]string{"ssh"}, c.args()...))

		ss := a.sessions
		ss.mu.Lock()
		var s *Session
		for _, x := range ss.list {
			if x.Project == p.ID && x.SSH == c.ID {
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
			s = &Session{ID: newID(), Project: p.ID, Kind: "command", Cwd: filepath.Clean(p.Path), SSH: c.ID, Tty: true}
			ss.add(s)
		}
		s.mu.Lock()
		s.Name = "SSH · " + c.Name
		s.Command = command
		s.Args = args
		s.Env = []string{
			"SSH_ASKPASS=" + exe,
			"SSH_ASKPASS_REQUIRE=force",
			fmt.Sprintf("DASHLITE_ASKPASS_URL=http://127.0.0.1:%d/api/askpass", a.port),
			"DASHLITE_ASKPASS_KEY=" + a.askpass.key,
			"DASHLITE_ASKPASS_SESSION=" + s.ID,
		}
		if os.Getenv("DISPLAY") == "" {
			s.Env = append(s.Env, "DISPLAY=:0") // OpenSSH < 8.4 only uses SSH_ASKPASS when DISPLAY is set
		}
		s.mu.Unlock()
		ss.note(s, fmt.Sprintf("\x1b[36m▶ %s\x1b[0m\r\n", command))
		if err := ss.start(s, command); err != nil {
			ss.note(s, "\x1b[31m"+err.Error()+"\x1b[0m\r\n")
			return nil, err
		}
		return s.snapshot(false), nil
	})

	a.register("ssh.answer", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			Ask    string `json:"ask"`
			Answer string `json:"answer"`
			Cancel bool   `json:"cancel"`
		}](raw)
		if err != nil {
			return nil, err
		}
		a.askpass.mu.Lock()
		p := a.askpass.pending[req.Ask]
		a.askpass.mu.Unlock()
		if p == nil {
			return nil, badRequest("question expirée")
		}
		select {
		case p.ch <- askpassAnswer{Answer: req.Answer, Cancel: req.Cancel}:
		default:
		}
		return nil, nil
	})
}
