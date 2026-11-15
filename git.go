package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var errNoGit = errors.New("git est introuvable : installez-le puis relancez l'application")

func runGit(dir string, timeout time.Duration, args ...string) (string, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return errNoGit.Error(), errNoGit
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	// no interactive editor ever: merge/rebase/cherry-pick keep their prepared messages
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "GCM_INTERACTIVE=auto", "GIT_EDITOR=true", "GIT_MERGE_AUTOEDIT=no")
	hideWindow(cmd)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	out := strings.TrimRight(buf.String(), "\n")
	if ctx.Err() == context.DeadlineExceeded {
		return out + "\n(délai dépassé)", ctx.Err()
	}
	return out, err
}

func gitOut(dir string, args ...string) (string, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return "", errNoGit
	}
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0")
	hideWindow(cmd)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return out.String(), errors.New(msg)
	}
	return out.String(), nil
}

type gitFile struct {
	Path      string `json:"path"`
	Orig      string `json:"orig,omitempty"`
	X         string `json:"x"`
	Y         string `json:"y"`
	Staged    bool   `json:"staged"`
	Unstaged  bool   `json:"unstaged"`
	Untracked bool   `json:"untracked"`
	Conflict  bool   `json:"conflict"`
}

type gitStatus struct {
	Repo     bool      `json:"repo"`
	Branch   string    `json:"branch"`
	Upstream string    `json:"upstream"`
	Ahead    int       `json:"ahead"`
	Behind   int       `json:"behind"`
	Detached bool      `json:"detached"`
	Files    []gitFile `json:"files"`
	Remotes  []string  `json:"remotes"`
	NoCommit bool      `json:"noCommit"`
	Op       string    `json:"op,omitempty"` // merge | rebase | cherry-pick | revert
	OpInfo   string    `json:"opInfo,omitempty"`
	MergeMsg string    `json:"mergeMsg,omitempty"`
	Conflict int       `json:"conflicts"`
	Error    string    `json:"error,omitempty"`
}

func isRepo(dir string) bool {
	out, err := gitOut(dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(out) == "true"
}

func statusOf(dir string) gitStatus {
	st := gitStatus{Files: []gitFile{}, Remotes: []string{}}
	if !isRepo(dir) {
		return st
	}
	st.Repo = true
	out, err := gitOut(dir, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal")
	if err != nil {
		st.Error = err.Error()
		return st
	}
	recs := strings.Split(out, "\x00")
	for i := 0; i < len(recs); i++ {
		r := recs[i]
		if r == "" {
			continue
		}
		switch {
		case strings.HasPrefix(r, "# branch.head "):
			st.Branch = strings.TrimPrefix(r, "# branch.head ")
			if st.Branch == "(detached)" {
				st.Detached = true
			}
		case strings.HasPrefix(r, "# branch.oid "):
			if strings.HasSuffix(r, "(initial)") {
				st.NoCommit = true
			}
		case strings.HasPrefix(r, "# branch.upstream "):
			st.Upstream = strings.TrimPrefix(r, "# branch.upstream ")
		case strings.HasPrefix(r, "# branch.ab "):
			f := strings.Fields(strings.TrimPrefix(r, "# branch.ab "))
			if len(f) == 2 {
				st.Ahead, _ = strconv.Atoi(strings.TrimPrefix(f[0], "+"))
				st.Behind, _ = strconv.Atoi(strings.TrimPrefix(f[1], "-"))
			}
		case strings.HasPrefix(r, "1 "):
			f := strings.SplitN(r, " ", 9)
			if len(f) == 9 {
				st.Files = append(st.Files, mkFile(f[1], f[8], ""))
			}
		case strings.HasPrefix(r, "2 "):
			f := strings.SplitN(r, " ", 10)
			if len(f) == 10 {
				orig := ""
				if i+1 < len(recs) {
					orig = recs[i+1]
					i++
				}
				st.Files = append(st.Files, mkFile(f[1], f[9], orig))
			}
		case strings.HasPrefix(r, "u "):
			f := strings.SplitN(r, " ", 11)
			if len(f) == 11 {
				gf := mkFile(f[1], f[10], "")
				gf.Conflict = true
				gf.Staged, gf.Unstaged = false, false // listed apart, in "Conflicts"
				st.Files = append(st.Files, gf)
				st.Conflict++
			}
		case strings.HasPrefix(r, "? "):
			st.Files = append(st.Files, gitFile{Path: r[2:], X: "?", Y: "?", Untracked: true, Unstaged: true})
		}
	}
	st.Op, st.OpInfo, st.MergeMsg = repoOperation(dir)
	if rem, err := gitOut(dir, "remote"); err == nil {
		for _, l := range strings.Split(strings.TrimSpace(rem), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				st.Remotes = append(st.Remotes, l)
			}
		}
	}
	return st
}

func gitDir(dir string) string {
	out, err := gitOut(dir, "rev-parse", "--git-dir")
	if err != nil {
		return ""
	}
	gd := strings.TrimSpace(out)
	if !filepath.IsAbs(gd) {
		gd = filepath.Join(dir, gd)
	}
	return gd
}

// repoOperation tells whether a merge, rebase, cherry-pick or revert is in progress.
func repoOperation(dir string) (op, info, msg string) {
	gd := gitDir(dir)
	if gd == "" {
		return
	}
	has := func(name string) bool { _, err := os.Stat(filepath.Join(gd, name)); return err == nil }
	read := func(name string) string {
		b, _ := os.ReadFile(filepath.Join(gd, name))
		return strings.TrimSpace(string(b))
	}
	switch {
	case has("rebase-merge") || has("rebase-apply"):
		op = "rebase"
		sub := "rebase-merge"
		if !has(sub) {
			sub = "rebase-apply"
		}
		head := strings.TrimPrefix(read(sub+"/head-name"), "refs/heads/")
		onto := read(sub + "/onto")
		if len(onto) > 8 {
			onto = onto[:8]
		}
		if n, t := read(sub+"/msgnum"), read(sub+"/end"); n != "" && t != "" {
			info = fmt.Sprintf("%s sur %s — commit %s/%s", head, onto, n, t)
		} else {
			info = head + " sur " + onto
		}
	case has("MERGE_HEAD"):
		op = "merge"
		info = mergeSource(read("MERGE_MSG"))
	case has("CHERRY_PICK_HEAD"):
		op = "cherry-pick"
		h := read("CHERRY_PICK_HEAD")
		if len(h) > 8 {
			h = h[:8]
		}
		info = h
	case has("REVERT_HEAD"):
		op = "revert"
	}
	if op == "merge" || op == "cherry-pick" || op == "revert" {
		var lines []string
		for _, l := range strings.Split(read("MERGE_MSG"), "\n") {
			if !strings.HasPrefix(l, "#") {
				lines = append(lines, l)
			}
		}
		msg = strings.TrimSpace(strings.Join(lines, "\n"))
	}
	return
}

func mergeSource(msg string) string {
	first := strings.SplitN(msg, "\n", 2)[0]
	first = strings.TrimPrefix(first, "Merge ")
	return first
}

func mkFile(xy, path, orig string) gitFile {
	x, y := string(xy[0]), string(xy[1])
	return gitFile{Path: path, Orig: orig, X: x, Y: y, Staged: x != ".", Unstaged: y != "."}
}

type opResult struct {
	OK     bool   `json:"ok"`
	Output string `json:"output"`
}

func pushArgs(dir string) ([]string, error) {
	st := statusOf(dir)
	if !st.Repo {
		return nil, errors.New("pas un dépôt git")
	}
	if st.Upstream != "" {
		return []string{"push"}, nil
	}
	if st.Detached {
		return nil, errors.New("HEAD détachée : choisissez une branche avant de pousser")
	}
	if len(st.Remotes) == 0 {
		return nil, errors.New("aucun remote : connectez d'abord un dépôt distant")
	}
	remote := st.Remotes[0]
	for _, r := range st.Remotes {
		if r == "origin" {
			remote = r
		}
	}
	return []string{"push", "-u", remote, "HEAD"}, nil
}

func (a *App) registerGit() {
	type pReq struct {
		P string `json:"p"`
	}
	gitProj := func(raw json.RawMessage) (*Project, error) {
		req, err := bind[pReq](raw)
		if err != nil {
			return nil, err
		}
		return a.proj(req.P)
	}
	op := func(dir string, timeout time.Duration, args ...string) (any, error) {
		out, err := runGit(dir, timeout, args...)
		return opResult{err == nil, out}, nil
	}

	a.register("git.status", func(raw json.RawMessage) (any, error) {
		p, err := gitProj(raw)
		if err != nil {
			return nil, err
		}
		if _, err := exec.LookPath("git"); err != nil {
			return gitStatus{Error: errNoGit.Error(), Files: []gitFile{}, Remotes: []string{}}, nil
		}
		return statusOf(p.Path), nil
	})

	a.register("git.diff", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P         string `json:"p"`
			Path      string `json:"path"`
			Staged    bool   `json:"staged"`
			Untracked bool   `json:"untracked"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		if req.Untracked {
			abs, err := p.resolve(req.Path)
			if err != nil {
				return nil, badRequest("%v", err)
			}
			data, err := os.ReadFile(abs)
			if err != nil {
				return map[string]string{"diff": "(dossier ou fichier illisible)"}, nil
			}
			if looksBinary(data) {
				return map[string]string{"diff": "(fichier binaire)"}, nil
			}
			var b strings.Builder
			b.WriteString("--- /dev/null\n+++ b/" + req.Path + "\n")
			lines := strings.Split(strings.TrimRight(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n"), "\n")
			b.WriteString("@@ -0,0 +1," + strconv.Itoa(len(lines)) + " @@\n")
			for _, l := range lines {
				b.WriteString("+" + l + "\n")
			}
			return map[string]string{"diff": b.String()}, nil
		}
		args := []string{"-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff"}
		if req.Staged {
			args = append(args, "--cached")
		}
		args = append(args, "--", req.Path)
		out, err := gitOut(p.Path, args...)
		if err != nil {
			return nil, err
		}
		return map[string]string{"diff": out}, nil
	})

	pathsReq := func(raw json.RawMessage) (*Project, []string, error) {
		req, err := bind[struct {
			P     string   `json:"p"`
			Paths []string `json:"paths"`
		}](raw)
		if err != nil {
			return nil, nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, nil, err
		}
		for _, x := range req.Paths {
			if _, err := p.resolve(x); err != nil {
				return nil, nil, badRequest("%v", err)
			}
		}
		return p, req.Paths, nil
	}

	a.register("git.stage", func(raw json.RawMessage) (any, error) {
		p, paths, err := pathsReq(raw)
		if err != nil {
			return nil, err
		}
		if force, _ := bind[struct{ Force bool }](raw); !force.Force {
			if left := filesWithMarkers(p, paths); len(left) > 0 {
				return nil, &apiError{409, "MARKERS:" + strings.Join(left, "\n")}
			}
		}
		args := []string{"add", "-A", "--"}
		if len(paths) == 0 {
			paths = []string{"."}
		}
		return op(p.Path, time.Minute, append(args, paths...)...)
	})

	a.register("git.unstage", func(raw json.RawMessage) (any, error) {
		p, paths, err := pathsReq(raw)
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			paths = []string{"."}
		}
		if statusOf(p.Path).NoCommit {
			return op(p.Path, time.Minute, append([]string{"rm", "-r", "-q", "--cached", "--"}, paths...)...)
		}
		return op(p.Path, time.Minute, append([]string{"reset", "-q", "HEAD", "--"}, paths...)...)
	})

	a.register("git.discard", func(raw json.RawMessage) (any, error) {
		p, paths, err := pathsReq(raw)
		if err != nil {
			return nil, err
		}
		st := statusOf(p.Path)
		untracked := map[string]bool{}
		for _, f := range st.Files {
			if f.Untracked {
				untracked[f.Path] = true
			}
		}
		var outs []string
		ok := true
		for _, x := range paths {
			var out string
			var err error
			if untracked[x] {
				out, err = runGit(p.Path, time.Minute, "clean", "-f", "-d", "-q", "--", x)
			} else {
				out, err = runGit(p.Path, time.Minute, "checkout", "-q", "--", x)
			}
			if err != nil {
				ok = false
			}
			if out != "" {
				outs = append(outs, out)
			}
		}
		return opResult{ok, strings.Join(outs, "\n")}, nil
	})

	a.register("git.commit", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P       string `json:"p"`
			Message string `json:"message"`
			All     bool   `json:"all"`
			Amend   bool   `json:"amend"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(req.Message) == "" && !req.Amend {
			return nil, badRequest("message de commit vide")
		}
		if req.All {
			if out, err := runGit(p.Path, time.Minute, "add", "-A"); err != nil {
				return opResult{false, out}, nil
			}
		}
		args := []string{"commit", "-m", req.Message}
		if req.Amend {
			args = []string{"commit", "--amend", "--no-edit"}
			if strings.TrimSpace(req.Message) != "" {
				args = []string{"commit", "--amend", "-m", req.Message}
			}
		}
		return op(p.Path, 2*time.Minute, args...)
	})

	a.register("git.push", func(raw json.RawMessage) (any, error) {
		p, err := gitProj(raw)
		if err != nil {
			return nil, err
		}
		args, err := pushArgs(p.Path)
		if err != nil {
			return opResult{false, err.Error()}, nil
		}
		return op(p.Path, 5*time.Minute, args...)
	})

	a.register("git.pull", func(raw json.RawMessage) (any, error) {
		p, err := gitProj(raw)
		if err != nil {
			return nil, err
		}
		return op(p.Path, 5*time.Minute, pullArgs(a.pullMode())...)
	})

	a.register("git.fetch", func(raw json.RawMessage) (any, error) {
		p, err := gitProj(raw)
		if err != nil {
			return nil, err
		}
		return op(p.Path, 5*time.Minute, "fetch", "--all", "--prune")
	})

	a.register("git.sync", func(raw json.RawMessage) (any, error) {
		p, err := gitProj(raw)
		if err != nil {
			return nil, err
		}
		return syncRepo(p.Path, a.pullMode()), nil
	})

	a.register("git.syncAll", func(raw json.RawMessage) (any, error) {
		a.store.mu.Lock()
		projects := append([]*Project(nil), a.store.cfg.Projects...)
		a.store.mu.Unlock()
		type res struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Status string `json:"status"` // ok | skipped | error
			Output string `json:"output"`
		}
		results := make([]res, len(projects))
		var wg sync.WaitGroup
		sem := make(chan struct{}, 4)
		for i, p := range projects {
			wg.Add(1)
			go func(i int, p *Project) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				r := res{ID: p.ID, Name: p.Name}
				if _, err := os.Stat(filepath.Join(p.Path, ".git")); err != nil {
					r.Status, r.Output = "skipped", "pas un dépôt git"
				} else {
					st := statusOf(p.Path)
					if st.Upstream == "" {
						r.Status, r.Output = "skipped", "pas de branche amont"
					} else {
						o := syncRepo(p.Path, "ff-only")
						r.Output = o.Output
						r.Status = "ok"
						if !o.OK {
							r.Status = "error"
						}
					}
				}
				results[i] = r
			}(i, p)
		}
		wg.Wait()
		return results, nil
	})

	a.register("git.branches", func(raw json.RawMessage) (any, error) {
		p, err := gitProj(raw)
		if err != nil {
			return nil, err
		}
		local, _ := gitOut(p.Path, "branch", "--format=%(refname:short)")
		remote, _ := gitOut(p.Path, "branch", "-r", "--format=%(refname:short)")
		split := func(s string) []string {
			out := []string{}
			for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
				l = strings.TrimSpace(l)
				if l != "" && !strings.HasSuffix(l, "/HEAD") && !strings.HasPrefix(l, "(") {
					out = append(out, l)
				}
			}
			return out
		}
		return map[string]any{"local": split(local), "remote": split(remote)}, nil
	})

	a.register("git.checkout", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P      string `json:"p"`
			Branch string `json:"branch"`
			Create bool   `json:"create"`
			Remote bool   `json:"remote"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		b := strings.TrimSpace(req.Branch)
		if b == "" || strings.HasPrefix(b, "-") || strings.ContainsAny(b, " ~^:?*[\\") {
			return nil, badRequest("nom de branche invalide")
		}
		switch {
		case req.Create:
			return op(p.Path, time.Minute, "checkout", "-b", b)
		case req.Remote:
			local := b
			if i := strings.IndexByte(b, '/'); i > 0 {
				local = b[i+1:]
			}
			return op(p.Path, time.Minute, "checkout", "-b", local, "--track", b)
		default:
			return op(p.Path, time.Minute, "checkout", b)
		}
	})

	a.register("git.log", func(raw json.RawMessage) (any, error) {
		p, err := gitProj(raw)
		if err != nil {
			return nil, err
		}
		out, err := gitOut(p.Path, "log", "-n", "200", "--date=relative", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s%x1f%D%x1e")
		if err != nil {
			return []any{}, nil
		}
		var list []map[string]string
		for _, rec := range strings.Split(out, "\x1e") {
			f := strings.Split(strings.TrimLeft(rec, "\n"), "\x1f")
			if len(f) == 5 {
				list = append(list, map[string]string{"hash": f[0], "author": f[1], "date": f[2], "subject": f[3], "refs": f[4]})
			}
		}
		if list == nil {
			list = []map[string]string{}
		}
		return list, nil
	})

	a.register("git.show", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P    string `json:"p"`
			Hash string `json:"hash"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		if strings.HasPrefix(req.Hash, "-") {
			return nil, badRequest("hash invalide")
		}
		out, err := gitOut(p.Path, "-c", "core.quotepath=off", "show", "--no-color", "--stat", "--patch", req.Hash)
		if err != nil {
			return nil, err
		}
		return map[string]string{"diff": out}, nil
	})

	a.register("git.remotes", func(raw json.RawMessage) (any, error) {
		p, err := gitProj(raw)
		if err != nil {
			return nil, err
		}
		out, _ := gitOut(p.Path, "remote", "-v")
		m := map[string]string{}
		for _, l := range strings.Split(out, "\n") {
			f := strings.Fields(l)
			if len(f) >= 2 {
				m[f[0]] = f[1]
			}
		}
		return m, nil
	})

	a.register("git.setRemote", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P    string `json:"p"`
			Name string `json:"name"`
			URL  string `json:"url"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		name := strings.TrimSpace(req.Name)
		if name == "" {
			name = "origin"
		}
		url := strings.TrimSpace(req.URL)
		if url == "" || strings.HasPrefix(url, "-") || strings.HasPrefix(name, "-") {
			return nil, badRequest("URL invalide")
		}
		if !isRepo(p.Path) {
			if out, err := runGit(p.Path, time.Minute, "init"); err != nil {
				return opResult{false, out}, nil
			}
		}
		if _, err := gitOut(p.Path, "remote", "get-url", name); err == nil {
			return op(p.Path, time.Minute, "remote", "set-url", name, url)
		}
		return op(p.Path, time.Minute, "remote", "add", name, url)
	})

	a.register("git.init", func(raw json.RawMessage) (any, error) {
		p, err := gitProj(raw)
		if err != nil {
			return nil, err
		}
		return op(p.Path, time.Minute, "init")
	})
}

func (a *App) pullMode() string {
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	if v, ok := a.store.cfg.Settings["pullMode"].(string); ok && (v == "merge" || v == "rebase" || v == "ff-only") {
		return v
	}
	return "merge"
}

func pullArgs(mode string) []string {
	switch mode {
	case "rebase":
		return []string{"pull", "--rebase"}
	case "ff-only":
		return []string{"pull", "--ff-only"}
	}
	return []string{"pull", "--no-rebase", "--no-edit"}
}

// syncRepo pulls (merge, rebase or fast-forward only) then pushes.
func syncRepo(dir string, mode string) opResult {
	pull := pullArgs(mode)
	out1, err := runGit(dir, 5*time.Minute, pull...)
	if err != nil {
		return opResult{false, "$ git " + strings.Join(pull, " ") + "\n" + out1}
	}
	args, err := pushArgs(dir)
	if err != nil {
		return opResult{false, out1 + "\n" + err.Error()}
	}
	out2, err := runGit(dir, 5*time.Minute, args...)
	return opResult{err == nil, "$ git " + strings.Join(pull, " ") + "\n" + out1 + "\n$ git " + strings.Join(args, " ") + "\n" + out2}
}

var markerStart = regexp.MustCompile(`(?m)^<{7}( |$)`)
var markerEnd = regexp.MustCompile(`(?m)^>{7}( |$)`)

// filesWithMarkers returns the conflicted files (among paths, or all) that still contain conflict markers.
func filesWithMarkers(p *Project, paths []string) []string {
	st := statusOf(p.Path)
	want := map[string]bool{}
	for _, x := range paths {
		want[x] = true
	}
	var left []string
	for _, f := range st.Files {
		if !f.Conflict || (len(paths) > 0 && !want[f.Path] && !(len(paths) == 1 && paths[0] == ".")) {
			continue
		}
		abs, err := p.resolve(f.Path)
		if err != nil {
			continue
		}
		data, err := os.ReadFile(abs)
		if err == nil && markerStart.Match(data) && markerEnd.Match(data) {
			left = append(left, f.Path)
		}
	}
	return left
}

func (a *App) registerConflicts() {
	a.register("git.resolveFile", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P    string `json:"p"`
			Path string `json:"path"`
			Side string `json:"side"` // current | incoming
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		if _, err := p.resolve(req.Path); err != nil {
			return nil, badRequest("%v", err)
		}
		// "current" is HEAD's side (--ours) and "incoming" the other one (--theirs), as in the markers.
		flag := "--ours"
		if req.Side == "incoming" {
			flag = "--theirs"
		}
		out, err := runGit(p.Path, time.Minute, "checkout", flag, "--", req.Path)
		if err != nil {
			// this side deleted the file: keeping it means deleting it
			if strings.Contains(out, "does not have") {
				out2, err2 := runGit(p.Path, time.Minute, "rm", "-q", "--", req.Path)
				return opResult{err2 == nil, out2}, nil
			}
			return opResult{false, out}, nil
		}
		out, err = runGit(p.Path, time.Minute, "add", "--", req.Path)
		return opResult{err == nil, out}, nil
	})

	a.register("git.abort", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P string `json:"p"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		op, _, _ := repoOperation(p.Path)
		if op == "" {
			return opResult{false, "aucune opération en cours"}, nil
		}
		out, err := runGit(p.Path, 2*time.Minute, op, "--abort")
		return opResult{err == nil, out}, nil
	})

	a.register("git.continue", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P       string `json:"p"`
			Message string `json:"message"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		op, _, _ := repoOperation(p.Path)
		if st := statusOf(p.Path); st.Conflict > 0 {
			return opResult{false, fmt.Sprintf("Il reste %d fichier(s) en conflit : résolvez-les puis marquez-les comme résolus (+).", st.Conflict)}, nil
		}
		var out string
		switch op {
		case "merge":
			args := []string{"commit", "--no-edit"}
			if m := strings.TrimSpace(req.Message); m != "" {
				args = []string{"commit", "-m", m}
			}
			out, err = runGit(p.Path, 2*time.Minute, args...)
		case "rebase", "cherry-pick", "revert":
			out, err = runGit(p.Path, 5*time.Minute, op, "--continue")
			if err != nil && op != "rebase" && strings.Contains(out, "nothing to commit") {
				out, err = runGit(p.Path, time.Minute, op, "--skip")
			}
		default:
			return opResult{false, "aucune opération en cours"}, nil
		}
		return opResult{err == nil, out}, nil
	})
}
