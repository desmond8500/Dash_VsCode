package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"unicode/utf8"
)

const maxEditable = 8 << 20

// Folders skipped by quick-open, search and task scanning (still visible in the explorer).
var heavyDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, ".next": true, ".nuxt": true,
	".svelte-kit": true, "target": true, "__pycache__": true, ".venv": true, "venv": true,
	".dart_tool": true, ".gradle": true, ".idea": true, ".vs": true, "dist": true,
	"build": true, "coverage": true, "obj": true, ".cache": true, ".turbo": true,
	".angular": true, "Pods": true, ".terraform": true, ".pytest_cache": true, ".mypy_cache": true,
}

type entry struct {
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	Link  bool   `json:"link,omitempty"`
}

func mtimeOf(st fs.FileInfo) int64 { return st.ModTime().UnixMilli() }

func looksBinary(b []byte) bool {
	n := len(b)
	if n > 8000 {
		n = 8000
	}
	return bytes.IndexByte(b[:n], 0) >= 0
}

func walkProject(root string, limit int, fn func(path string, d fs.DirEntry) bool) {
	count := 0
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if path != root && heavyDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		count++
		if count > limit {
			return filepath.SkipAll
		}
		if !fn(path, d) {
			return filepath.SkipAll
		}
		return nil
	})
}

func (a *App) proj(id string) (*Project, error) {
	p, err := a.store.project(id)
	if err != nil {
		return nil, &apiError{404, err.Error()}
	}
	return p, nil
}

func (a *App) registerFS() {
	type pathReq struct {
		P    string `json:"p"`
		Path string `json:"path"`
	}

	a.register("fs.list", func(raw json.RawMessage) (any, error) {
		req, err := bind[pathReq](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		abs, err := p.resolve(req.Path)
		if err != nil {
			return nil, badRequest("%v", err)
		}
		des, err := os.ReadDir(abs)
		if err != nil {
			return nil, badRequest("lecture impossible : %v", err)
		}
		out := make([]entry, 0, len(des))
		for _, d := range des {
			if d.Name() == ".git" || d.Name() == ".DS_Store" {
				continue
			}
			e := entry{Name: d.Name(), Dir: d.IsDir()}
			if d.Type()&fs.ModeSymlink != 0 {
				e.Link = true
				if st, err := os.Stat(filepath.Join(abs, d.Name())); err == nil {
					e.Dir = st.IsDir()
				}
			}
			if info, err := d.Info(); err == nil {
				e.Size = info.Size()
				e.Mtime = mtimeOf(info)
			}
			out = append(out, e)
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Dir != out[j].Dir {
				return out[i].Dir
			}
			return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
		})
		return out, nil
	})

	a.register("fs.read", func(raw json.RawMessage) (any, error) {
		req, err := bind[pathReq](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		abs, err := p.resolve(req.Path)
		if err != nil {
			return nil, badRequest("%v", err)
		}
		st, err := os.Stat(abs)
		if err != nil {
			return nil, &apiError{404, "fichier introuvable"}
		}
		if st.IsDir() {
			return nil, badRequest("c'est un dossier")
		}
		res := map[string]any{"mtime": mtimeOf(st), "size": st.Size()}
		if st.Size() > maxEditable {
			res["tooLarge"] = true
			return res, nil
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			return nil, err
		}
		if looksBinary(data) {
			res["binary"] = true
			return res, nil
		}
		text := string(data)
		if !utf8.ValidString(text) {
			// Latin-1 fallback so legacy files stay editable
			rs := make([]rune, len(data))
			for i, b := range data {
				rs[i] = rune(b)
			}
			text = string(rs)
			res["encoding"] = "latin1"
		}
		if strings.HasPrefix(text, "\ufeff") {
			text = text[3:]
			res["bom"] = true
		}
		if strings.Contains(text, "\r\n") {
			res["eol"] = "crlf"
			text = strings.ReplaceAll(text, "\r\n", "\n")
		}
		res["content"] = text
		return res, nil
	})

	a.register("fs.write", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P        string `json:"p"`
			Path     string `json:"path"`
			Content  string `json:"content"`
			Mtime    int64  `json:"mtime"`
			Force    bool   `json:"force"`
			Eol      string `json:"eol"`
			Bom      bool   `json:"bom"`
			Encoding string `json:"encoding"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		abs, err := p.resolve(req.Path)
		if err != nil {
			return nil, badRequest("%v", err)
		}
		if st, err := os.Stat(abs); err == nil {
			if st.IsDir() {
				return nil, badRequest("c'est un dossier")
			}
			if !req.Force && req.Mtime != 0 && mtimeOf(st) != req.Mtime {
				return nil, &apiError{409, "le fichier a été modifié sur le disque"}
			}
		}
		text := req.Content
		if req.Eol == "crlf" {
			text = strings.ReplaceAll(text, "\n", "\r\n")
		}
		var data []byte
		if req.Encoding == "latin1" {
			data = make([]byte, 0, len(text))
			for _, r := range text {
				if r > 255 {
					r = '?'
				}
				data = append(data, byte(r))
			}
		} else {
			if req.Bom {
				text = "\ufeff" + text
			}
			data = []byte(text)
		}
		mode := fs.FileMode(0o644)
		if st, err := os.Stat(abs); err == nil {
			mode = st.Mode().Perm()
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(abs, data, mode); err != nil {
			return nil, err
		}
		st, _ := os.Stat(abs)
		return map[string]any{"mtime": mtimeOf(st)}, nil
	})

	a.register("fs.create", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P    string `json:"p"`
			Path string `json:"path"`
			Dir  bool   `json:"dir"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(req.Path) == "" {
			return nil, badRequest("nom vide")
		}
		abs, err := p.resolve(req.Path)
		if err != nil {
			return nil, badRequest("%v", err)
		}
		if _, err := os.Stat(abs); err == nil {
			return nil, badRequest("« %s » existe déjà", req.Path)
		}
		if req.Dir {
			return nil, os.MkdirAll(abs, 0o755)
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(abs, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			return nil, err
		}
		return nil, f.Close()
	})

	a.register("fs.rename", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P    string `json:"p"`
			From string `json:"from"`
			To   string `json:"to"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		from, err := p.resolve(req.From)
		if err != nil {
			return nil, badRequest("%v", err)
		}
		to, err := p.resolve(req.To)
		if err != nil {
			return nil, badRequest("%v", err)
		}
		if from == filepath.Clean(p.Path) {
			return nil, badRequest("impossible de renommer la racine")
		}
		if _, err := os.Stat(to); err == nil && !strings.EqualFold(from, to) {
			return nil, badRequest("« %s » existe déjà", req.To)
		}
		os.MkdirAll(filepath.Dir(to), 0o755)
		return nil, os.Rename(from, to)
	})

	a.register("fs.delete", func(raw json.RawMessage) (any, error) {
		req, err := bind[pathReq](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		abs, err := p.resolve(req.Path)
		if err != nil {
			return nil, badRequest("%v", err)
		}
		if abs == filepath.Clean(p.Path) || strings.Trim(req.Path, "/. ") == "" {
			return nil, badRequest("impossible de supprimer la racine du projet")
		}
		return nil, os.RemoveAll(abs)
	})

	a.register("fs.stat", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P     string   `json:"p"`
			Paths []string `json:"paths"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		out := map[string]int64{}
		for _, rel := range req.Paths {
			abs, err := p.resolve(rel)
			if err != nil {
				continue
			}
			if st, err := os.Stat(abs); err == nil {
				out[rel] = mtimeOf(st)
			} else {
				out[rel] = -1
			}
		}
		return out, nil
	})

	a.register("fs.files", func(raw json.RawMessage) (any, error) {
		req, err := bind[pathReq](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		files := []string{}
		walkProject(p.Path, 30000, func(path string, d fs.DirEntry) bool {
			files = append(files, p.rel(path))
			return true
		})
		return files, nil
	})

	// Folder picker for adding projects: not confined, directories only.
	a.register("fs.browse", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ Path string }](raw)
		if err != nil {
			return nil, err
		}
		path := req.Path
		if strings.TrimSpace(path) == "" {
			path, _ = os.UserHomeDir()
		}
		path = expandHome(path)
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		des, err := os.ReadDir(abs)
		if err != nil {
			return nil, badRequest("lecture impossible : %v", err)
		}
		dirs := []string{}
		for _, d := range des {
			isDir := d.IsDir()
			if d.Type()&fs.ModeSymlink != 0 {
				if st, err := os.Stat(filepath.Join(abs, d.Name())); err == nil {
					isDir = st.IsDir()
				}
			}
			if isDir {
				dirs = append(dirs, d.Name())
			}
		}
		sort.Slice(dirs, func(i, j int) bool { return strings.ToLower(dirs[i]) < strings.ToLower(dirs[j]) })
		parent := filepath.Dir(abs)
		if parent == abs {
			parent = ""
		}
		_, gerr := os.Stat(filepath.Join(abs, ".git"))
		home, _ := os.UserHomeDir()
		return map[string]any{"path": abs, "parent": parent, "dirs": dirs, "roots": fsRoots(), "home": home, "git": gerr == nil}, nil
	})

	a.register("search", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P     string `json:"p"`
			Query string `json:"query"`
			Regex bool   `json:"regex"`
			Case  bool   `json:"case"`
			Word  bool   `json:"word"`
			Glob  string `json:"glob"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		if req.Query == "" {
			return []any{}, nil
		}
		pat := req.Query
		if !req.Regex {
			pat = regexp.QuoteMeta(pat)
		}
		if req.Word {
			pat = `\b` + pat + `\b`
		}
		if !req.Case {
			pat = "(?i)" + pat
		}
		re, err := regexp.Compile(pat)
		if err != nil {
			return nil, badRequest("expression invalide : %v", err)
		}
		globs := splitGlobs(req.Glob)
		type hit struct {
			Path string `json:"path"`
			Line int    `json:"line"`
			Col  int    `json:"col"`
			Len  int    `json:"len"`
			Text string `json:"text"`
		}
		hits := []hit{}
		truncated := false
		walkProject(p.Path, 50000, func(path string, d fs.DirEntry) bool {
			rel := p.rel(path)
			if len(globs) > 0 && !matchGlobs(globs, rel) {
				return true
			}
			info, err := d.Info()
			if err != nil || info.Size() > 2<<20 {
				return true
			}
			data, err := os.ReadFile(path)
			if err != nil || looksBinary(data) {
				return true
			}
			sc := bufio.NewScanner(bytes.NewReader(data))
			sc.Buffer(make([]byte, 64*1024), 4<<20)
			n := 0
			for sc.Scan() {
				n++
				line := sc.Text()
				if loc := re.FindStringIndex(line); loc != nil {
					text := line
					col := loc[0]
					if len(text) > 300 {
						start := col - 60
						if start < 0 {
							start = 0
						}
						for start > 0 && !utf8.RuneStart(text[start]) {
							start--
						}
						end := start + 300
						if end > len(text) {
							end = len(text)
						}
						for end < len(text) && !utf8.RuneStart(text[end]) {
							end++
						}
						text = text[start:end]
						col -= start
					}
					hits = append(hits, hit{rel, n, utf8.RuneCountInString(text[:col]), utf8.RuneCountInString(line[loc[0]:loc[1]]), text})
					if len(hits) >= 3000 {
						truncated = true
						return false
					}
				}
			}
			return true
		})
		return map[string]any{"hits": hits, "truncated": truncated}, nil
	})

	a.registerTasks()
}

func splitGlobs(s string) []string {
	var out []string
	for _, g := range strings.Split(s, ",") {
		if g = strings.TrimSpace(g); g != "" {
			out = append(out, g)
		}
	}
	return out
}

func matchGlobs(globs []string, rel string) bool {
	base := filepath.Base(rel)
	for _, g := range globs {
		if ok, _ := filepath.Match(g, base); ok {
			return true
		}
		if ok, _ := filepath.Match(g, rel); ok {
			return true
		}
		if strings.HasSuffix(g, "/") && strings.HasPrefix(rel, g) {
			return true
		}
		if strings.HasSuffix(g, "/**") && strings.HasPrefix(rel, strings.TrimSuffix(g, "**")) {
			return true
		}
	}
	return false
}

func fsRoots() []string {
	if runtime.GOOS != "windows" {
		roots := []string{"/"}
		if runtime.GOOS == "darwin" {
			roots = append(roots, "/Volumes")
		} else if _, err := os.Stat("/mnt"); err == nil {
			roots = append(roots, "/mnt", "/media")
		}
		return roots
	}
	var roots []string
	for c := 'A'; c <= 'Z'; c++ {
		d := string(c) + `:\`
		if _, err := os.Stat(d); err == nil {
			roots = append(roots, d)
		}
	}
	return roots
}

// ---------------------------------------------------------------- tasks

var (
	taskRe        = regexp.MustCompile(`^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s?(.*)$`)
	headingRe     = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*#*\s*$`)
	fenceRe       = regexp.MustCompile("^\\s*(```|~~~)")
	htmlHeadingRe = regexp.MustCompile(`(?i)^\s*<h([1-6])\b[^>]*>(.*?)</h[1-6]>\s*$`)
	tagRe         = regexp.MustCompile(`<[^>]+>`)
	listItemRe    = regexp.MustCompile(`^\s*([-*+]|\d+[.)])\s`)
)

func isMarkdown(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".md", ".markdown", ".mdx", ".mdown":
		return true
	}
	return false
}

func (a *App) registerTasks() {
	a.register("tasks.list", func(raw json.RawMessage) (any, error) {
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
		type task struct {
			Path    string `json:"path"`
			Line    int    `json:"line"`
			Text    string `json:"text"`
			Done    bool   `json:"done"`
			Heading string `json:"heading"`
			HLine   int    `json:"headingLine"`
			Indent  int    `json:"indent"`
		}
		tasks := []task{}
		walkProject(p.Path, 50000, func(path string, d fs.DirEntry) bool {
			if !isMarkdown(d.Name()) {
				return true
			}
			info, err := d.Info()
			if err != nil || info.Size() > 2<<20 {
				return true
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return true
			}
			rel := p.rel(path)
			heading := ""
			hline := 0
			inFence := false
			for i, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
				if fenceRe.MatchString(line) {
					inFence = !inFence
					continue
				}
				if inFence {
					continue
				}
				if m := headingRe.FindStringSubmatch(line); m != nil {
					heading, hline = m[2], i+1
					continue
				}
				if m := htmlHeadingRe.FindStringSubmatch(line); m != nil {
					heading, hline = tagRe.ReplaceAllString(m[2], ""), i+1
					continue
				}
				if m := taskRe.FindStringSubmatch(line); m != nil {
					indent := len(strings.ReplaceAll(m[1], "\t", "  "))
					tasks = append(tasks, task{rel, i + 1, m[3], m[2] != " ", heading, hline, indent})
				}
			}
			return len(tasks) < 20000
		})
		return tasks, nil
	})

	a.register("tasks.toggle", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P    string `json:"p"`
			Path string `json:"path"`
			Line int    `json:"line"`
			Done bool   `json:"done"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		abs, err := p.resolve(req.Path)
		if err != nil {
			return nil, badRequest("%v", err)
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			return nil, err
		}
		text := string(data)
		crlf := strings.Contains(text, "\r\n")
		lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
		if req.Line < 1 || req.Line > len(lines) {
			return nil, &apiError{409, "ligne introuvable — le fichier a changé"}
		}
		line := lines[req.Line-1]
		loc := regexp.MustCompile(`^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]`).FindStringSubmatchIndex(line)
		if loc == nil {
			return nil, &apiError{409, "ce n'est plus une tâche — le fichier a changé"}
		}
		mark := " "
		if req.Done {
			mark = "x"
		}
		lines[req.Line-1] = line[:loc[2]] + mark + line[loc[3]:]
		out := strings.Join(lines, "\n")
		if crlf {
			out = strings.ReplaceAll(out, "\n", "\r\n")
		}
		st, _ := os.Stat(abs)
		if err := os.WriteFile(abs, []byte(out), st.Mode().Perm()); err != nil {
			return nil, err
		}
		st, _ = os.Stat(abs)
		return map[string]any{"mtime": mtimeOf(st)}, nil
	})

	a.register("tasks.add", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P       string `json:"p"`
			File    string `json:"file"`
			Text    string `json:"text"`
			Section int    `json:"section"` // 1-based heading line, 0 = end of file
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		text := strings.TrimSpace(strings.ReplaceAll(req.Text, "\n", " "))
		if text == "" {
			return nil, badRequest("tâche vide")
		}
		file := strings.TrimSpace(req.File)
		if file == "" {
			file = "TODO.md"
		}
		if !isMarkdown(file) {
			return nil, badRequest("le fichier des tâches doit être un fichier Markdown")
		}
		abs, err := p.resolve(file)
		if err != nil {
			return nil, badRequest("%v", err)
		}
		data, err := os.ReadFile(abs)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		content := string(data)
		nl := "\n"
		if strings.Contains(content, "\r\n") {
			nl = "\r\n"
		}
		if req.Section > 0 && content != "" {
			lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
			out, ok := insertTaskInSection(lines, req.Section-1, text)
			if !ok {
				return nil, &apiError{409, "section introuvable — le fichier a changé"}
			}
			content = strings.Join(out, nl)
		} else {
			if content == "" {
				content = "# TODO" + nl + nl
			} else if !strings.HasSuffix(content, "\n") {
				content += nl
			}
			content += "- [ ] " + text + nl
		}
		os.MkdirAll(filepath.Dir(abs), 0o755)
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			return nil, err
		}
		return map[string]any{"file": file}, nil
	})
}

func isHeadingLine(lines []string, i int) bool {
	l := lines[i]
	return headingRe.MatchString(l) || htmlHeadingRe.MatchString(l)
}

// insertTaskInSection adds "- [ ] text" at the end of the section's own content,
// before its first subsection (same rule as the editor).
func insertTaskInSection(lines []string, h int, text string) ([]string, bool) {
	if h < 0 || h >= len(lines) {
		return nil, false
	}
	headEnd := h + 1
	if !isHeadingLine(lines, h) {
		if h+1 < len(lines) && regexp.MustCompile(`^\s{0,3}(=+|-{2,})\s*$`).MatchString(lines[h+1]) && strings.TrimSpace(lines[h]) != "" {
			headEnd = h + 2 // setext heading
		} else {
			return nil, false
		}
	}
	end := len(lines)
	inFence := false
	for i := headEnd; i < len(lines); i++ {
		if fenceRe.MatchString(lines[i]) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if isHeadingLine(lines, i) || (i+1 < len(lines) && strings.TrimSpace(lines[i]) != "" && (i == 0 || strings.TrimSpace(lines[i-1]) == "") && regexp.MustCompile(`^\s{0,3}(=+|-{2,})\s*$`).MatchString(lines[i+1]) && !listItemRe.MatchString(lines[i])) {
			end = i
			break
		}
	}
	at := end
	for at > headEnd && strings.TrimSpace(lines[at-1]) == "" {
		at--
	}
	out := append([]string{}, lines[:at]...)
	if prev := out[len(out)-1]; strings.TrimSpace(prev) != "" && !listItemRe.MatchString(prev) {
		out = append(out, "")
	}
	out = append(out, "- [ ] "+text)
	rest := lines[at:]
	if len(rest) > 0 && strings.TrimSpace(rest[0]) != "" {
		out = append(out, "")
	}
	return append(out, rest...), true
}
