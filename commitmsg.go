package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Local, offline commit message suggestion: looks at which files changed, how,
// and what happened to Markdown tasks and headings, then writes a conventional
// commit message in French ("type(portée): résumé" + details).

type changedFile struct {
	Path    string
	Old     string // previous path for renames
	Kind    string // A (added) M (modified) D (deleted) R (renamed)
	Added   int
	Removed int
	Binary  bool
}

type mdChanges struct {
	checked, unchecked, added, removed []string
	sectionsAdded, sectionsRemoved     []string
}

var (
	mdTaskRe    = regexp.MustCompile(`^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s*(.*)$`)
	mdHeadingRe = regexp.MustCompile(`^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$`)
)

// files in the commit: staged ones, or everything when nothing is staged (as the Commit button does)
func commitScope(dir string) (files []changedFile, stagedOnly bool, err error) {
	st := statusOf(dir)
	if !st.Repo {
		return nil, false, badRequest("pas un dépôt git")
	}
	for _, f := range st.Files {
		if f.Staged {
			stagedOnly = true
			break
		}
	}
	args := []string{"-c", "core.quotepath=off", "diff", "--numstat", "-z", "-M"}
	switch {
	case stagedOnly:
		args = append(args, "--cached")
	case !st.NoCommit:
		args = append(args, "HEAD")
	default:
		args = append(args, "--cached") // no commit yet: compare index (untracked handled below)
	}
	out, err := gitOut(dir, args...)
	if err != nil {
		return nil, false, err
	}
	kinds := map[string]string{}
	for _, f := range st.Files {
		k := f.X
		if !stagedOnly && (k == "." || k == "?") {
			k = f.Y
		}
		if f.Untracked {
			k = "A"
		}
		kinds[strings.TrimSuffix(f.Path, "/")] = k
	}
	recs := strings.Split(out, "\x00")
	for i := 0; i < len(recs); i++ {
		r := recs[i]
		if r == "" {
			continue
		}
		parts := strings.SplitN(r, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		cf := changedFile{}
		if parts[0] == "-" {
			cf.Binary = true
		} else {
			cf.Added, _ = strconv.Atoi(parts[0])
			cf.Removed, _ = strconv.Atoi(parts[1])
		}
		if parts[2] == "" && i+2 < len(recs) { // rename: "a\td\t\0old\0new"
			cf.Old, cf.Path, cf.Kind = recs[i+1], recs[i+2], "R"
			i += 2
		} else {
			cf.Path = parts[2]
			cf.Kind = kinds[cf.Path]
			if cf.Kind == "" || cf.Kind == "." {
				cf.Kind = "M"
			}
		}
		files = append(files, cf)
	}
	if !stagedOnly {
		for _, f := range st.Files {
			if !f.Untracked {
				continue
			}
			for _, p := range expandUntracked(dir, f.Path) {
				cf := changedFile{Path: p, Kind: "A"}
				if data, err := os.ReadFile(dir + string(os.PathSeparator) + p); err == nil {
					if looksBinary(data) {
						cf.Binary = true
					} else {
						cf.Added = bytes.Count(data, []byte("\n"))
						if len(data) > 0 && data[len(data)-1] != '\n' {
							cf.Added++
						}
					}
				}
				files = append(files, cf)
			}
		}
	}
	return files, stagedOnly, nil
}

// untracked folders show up as "dir/": list the files inside
func expandUntracked(dir, p string) []string {
	if !strings.HasSuffix(p, "/") {
		return []string{p}
	}
	out, err := gitOut(dir, "-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z", "--", p)
	if err != nil {
		return []string{strings.TrimSuffix(p, "/")}
	}
	var list []string
	for _, x := range strings.Split(out, "\x00") {
		if x != "" {
			list = append(list, x)
		}
	}
	if len(list) > 200 {
		list = list[:200]
	}
	return list
}

func analyzeMarkdown(dir string, files []changedFile, stagedOnly, noCommit bool) map[string]*mdChanges {
	res := map[string]*mdChanges{}
	for _, f := range files {
		if !isMarkdown(f.Path) || f.Binary {
			continue
		}
		var minus, plus []string
		if f.Kind == "A" && !stagedOnly {
			data, _ := os.ReadFile(dir + string(os.PathSeparator) + f.Path)
			plus = strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
		} else {
			args := []string{"-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "-U0"}
			if stagedOnly || noCommit {
				args = append(args, "--cached")
			} else {
				args = append(args, "HEAD")
			}
			args = append(args, "--", f.Path)
			out, err := gitOut(dir, args...)
			if err != nil {
				continue
			}
			for _, l := range strings.Split(out, "\n") {
				switch {
				case strings.HasPrefix(l, "+++") || strings.HasPrefix(l, "---"):
				case strings.HasPrefix(l, "+"):
					plus = append(plus, strings.TrimSuffix(l[1:], "\r"))
				case strings.HasPrefix(l, "-"):
					minus = append(minus, strings.TrimSuffix(l[1:], "\r"))
				}
			}
		}
		mc := &mdChanges{}
		before := map[string]bool{} // task text -> done
		beforeHeads := map[string]int{}
		for _, l := range minus {
			if m := mdTaskRe.FindStringSubmatch(l); m != nil {
				before[strings.TrimSpace(m[2])] = m[1] != " "
			} else if m := mdHeadingRe.FindStringSubmatch(l); m != nil {
				beforeHeads[m[1]]++
			}
		}
		seen := map[string]bool{}
		for _, l := range plus {
			if m := mdTaskRe.FindStringSubmatch(l); m != nil {
				text, done := strings.TrimSpace(m[2]), m[1] != " "
				seen[text] = true
				if was, ok := before[text]; ok {
					if !was && done {
						mc.checked = append(mc.checked, text)
					} else if was && !done {
						mc.unchecked = append(mc.unchecked, text)
					}
				} else if text != "" {
					mc.added = append(mc.added, text)
				}
			} else if m := mdHeadingRe.FindStringSubmatch(l); m != nil {
				if beforeHeads[m[1]] > 0 {
					beforeHeads[m[1]]--
				} else {
					mc.sectionsAdded = append(mc.sectionsAdded, m[1])
				}
			}
		}
		for text := range before {
			if !seen[text] && text != "" {
				mc.removed = append(mc.removed, text)
			}
		}
		sort.Strings(mc.removed)
		for h, n := range beforeHeads {
			for ; n > 0; n-- {
				mc.sectionsRemoved = append(mc.sectionsRemoved, h)
			}
		}
		sort.Strings(mc.sectionsRemoved)
		res[f.Path] = mc
	}
	return res
}

// ---------------------------------------------------------------- classification

func category(p string) string {
	lp := strings.ToLower(p)
	base := path.Base(lp)
	ext := path.Ext(base)
	switch {
	case strings.HasPrefix(lp, ".github/workflows/") || base == ".gitlab-ci.yml" || strings.HasPrefix(lp, ".circleci/") || base == "azure-pipelines.yml" || base == "jenkinsfile":
		return "ci"
	case isDepsFile(base):
		return "deps"
	case base == "dockerfile" || strings.HasPrefix(base, "docker-compose") || strings.HasPrefix(base, "compose.") || base == "makefile" || base == "justfile" ||
		ext == ".gradle" || base == "build.gradle.kts" || base == "pom.xml" || strings.HasSuffix(base, ".csproj") || base == "vite.config.js" || base == "vite.config.ts" ||
		base == "webpack.config.js" || base == "tsconfig.json" || strings.HasPrefix(lp, "build/"):
		return "build"
	case strings.Contains(lp, "/test/") || strings.Contains(lp, "/tests/") || strings.HasPrefix(lp, "test/") || strings.HasPrefix(lp, "tests/") ||
		strings.Contains(lp, "__tests__/") || strings.HasSuffix(base, "_test.go") || strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") ||
		strings.HasPrefix(base, "test_") || strings.HasSuffix(base, "test.php") || strings.HasSuffix(base, "_test.dart"):
		return "test"
	case isMarkdown(base) || ext == ".txt" || ext == ".rst" || ext == ".adoc" || strings.HasPrefix(lp, "docs/") || strings.HasPrefix(lp, "doc/") || base == "license" || base == "changelog":
		return "docs"
	case ext == ".css" || ext == ".scss" || ext == ".sass" || ext == ".less":
		return "style"
	case strings.HasPrefix(base, ".") || ext == ".yml" || ext == ".yaml" || ext == ".toml" || ext == ".ini" || ext == ".env" || base == ".gitignore" || base == ".editorconfig" ||
		strings.HasPrefix(base, ".env") || strings.HasPrefix(lp, "config/"):
		return "config"
	case ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" || ext == ".svg" || ext == ".webp" || ext == ".ico" || ext == ".woff" || ext == ".woff2" || ext == ".ttf" || ext == ".mp3" || ext == ".mp4":
		return "assets"
	}
	return "code"
}

func isDepsFile(base string) bool {
	switch base {
	case "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "composer.json", "composer.lock",
		"go.mod", "go.sum", "cargo.toml", "cargo.lock", "requirements.txt", "pipfile", "pipfile.lock", "poetry.lock", "pyproject.toml", "uv.lock",
		"pubspec.yaml", "pubspec.lock", "gemfile", "gemfile.lock", "deno.json", "deno.lock":
		return true
	}
	return false
}

// scope: shared top-level folder (or file name for a single file)
func commitScopeName(files []changedFile) string {
	if len(files) == 1 {
		if d := path.Dir(files[0].Path); d != "." {
			if s := commitScopeName(append(files, changedFile{Path: d + "/_"})); s != "" {
				return s
			}
		}
		b := path.Base(files[0].Path)
		if i := strings.Index(b, "."); i > 0 {
			b = b[:i]
		}
		return b
	}
	var common []string
	for i, f := range files {
		parts := strings.Split(path.Dir(f.Path), "/")
		if parts[0] == "." {
			return ""
		}
		if i == 0 {
			common = parts
			continue
		}
		n := 0
		for n < len(common) && n < len(parts) && common[n] == parts[n] {
			n++
		}
		common = common[:n]
		if n == 0 {
			return ""
		}
	}
	// "src/components/ui" → "ui", but skip generic folder names
	for i := len(common) - 1; i >= 0; i-- {
		switch strings.ToLower(common[i]) {
		case "src", "app", "lib", "source", "internal", "pkg", "public", "resources":
			continue
		}
		return common[i]
	}
	return ""
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

func quoteList(items []string, max int) string {
	var q []string
	for i, it := range items {
		if i == max {
			q = append(q, fmt.Sprintf("et %d autre(s)", len(items)-max))
			break
		}
		if len([]rune(it)) > 40 {
			it = string([]rune(it)[:39]) + "…"
		}
		q = append(q, "« "+it+" »")
	}
	return strings.Join(q, ", ")
}

func nameList(files []changedFile, max int) string {
	var names []string
	for i, f := range files {
		if i == max {
			return strings.Join(names, ", ") + fmt.Sprintf(" et %d autre(s)", len(files)-max)
		}
		names = append(names, path.Base(f.Path))
	}
	if len(names) > 1 {
		return strings.Join(names[:len(names)-1], ", ") + " et " + names[len(names)-1]
	}
	return strings.Join(names, "")
}

func suggestCommit(dir string) (map[string]any, error) {
	files, stagedOnly, err := commitScope(dir)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, badRequest("aucune modification à décrire")
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	st := statusOf(dir)
	md := analyzeMarkdown(dir, files, stagedOnly, st.NoCommit)

	// counts
	cats := map[string]int{}
	kinds := map[string]int{}
	codeKinds := map[string]int{}
	codeAdd, codeDel := 0, 0
	for _, f := range files {
		c := category(f.Path)
		cats[c]++
		kinds[f.Kind]++
		if c == "code" {
			codeKinds[f.Kind]++
			codeAdd += f.Added
			codeDel += f.Removed
		}
	}
	only := func(c ...string) bool {
		n := 0
		for _, x := range c {
			n += cats[x]
		}
		return n == len(files)
	}

	typ := "chore"
	switch {
	case only("docs"):
		typ = "docs"
	case only("test"):
		typ = "test"
	case only("ci"):
		typ = "ci"
	case only("deps"):
		typ = "build"
	case only("build", "deps"):
		typ = "build"
	case only("style"):
		typ = "style"
	case only("config"):
		typ = "chore"
	case codeKinds["A"] > 0:
		typ = "feat"
	case codeKinds["R"] > 0 && codeAdd <= codeDel+5:
		typ = "refactor"
	case cats["code"] > 0 && codeKinds["D"] == cats["code"]:
		typ = "refactor"
	case cats["code"] > 0 && codeAdd >= 2*codeDel && codeAdd >= 20:
		typ = "feat"
	case cats["code"] > 0 && codeDel > codeAdd:
		typ = "refactor"
	case cats["code"] > 0 && codeAdd+codeDel <= 12:
		typ = "fix"
	}
	if typ == "docs" && only("docs") && len(md) > 0 {
		// checking tasks is project tracking rather than documentation
		taskOnly := true
		for _, f := range files {
			mc := md[f.Path]
			if mc == nil || (len(mc.checked)+len(mc.unchecked)+len(mc.added)+len(mc.removed) == 0) {
				taskOnly = false
			}
		}
		if taskOnly {
			typ = "chore"
		}
	}
	scope := commitScopeName(files)

	// subject
	var subject string
	verb := func(k string) string {
		switch k {
		case "A":
			return "ajoute"
		case "D":
			return "supprime"
		case "R":
			return "renomme"
		}
		return "met à jour"
	}
	taskSummary := func(mc *mdChanges) string {
		var parts []string
		if n := len(mc.checked); n > 0 {
			parts = append(parts, "coche "+plural(n, "tâche", "tâches"))
		}
		if n := len(mc.added); n > 0 {
			parts = append(parts, "ajoute "+plural(n, "tâche", "tâches"))
		}
		if n := len(mc.unchecked); n > 0 {
			parts = append(parts, "rouvre "+plural(n, "tâche", "tâches"))
		}
		if n := len(mc.removed); n > 0 {
			parts = append(parts, "retire "+plural(n, "tâche", "tâches"))
		}
		if n := len(mc.sectionsAdded); n > 0 && len(parts) < 2 {
			parts = append(parts, "ajoute "+plural(n, "section", "sections"))
		}
		return strings.Join(parts, ", ")
	}
	if len(files) == 1 {
		f := files[0]
		mc := md[f.Path]
		switch {
		case mc != nil && taskSummary(mc) != "" && f.Kind == "M":
			subject = taskSummary(mc)
			if len(mc.checked) == 1 && len(mc.added)+len(mc.unchecked)+len(mc.removed) == 0 {
				subject = "coche « " + truncate(mc.checked[0], 45) + " »"
			} else if len(mc.added) == 1 && len(mc.checked)+len(mc.unchecked)+len(mc.removed) == 0 {
				subject = "ajoute la tâche « " + truncate(mc.added[0], 40) + " »"
			}
		case f.Kind == "R":
			subject = "renomme " + path.Base(f.Old) + " en " + path.Base(f.Path)
		default:
			subject = verb(f.Kind) + " " + path.Base(f.Path)
		}
	} else {
		// dominant action
		dom, n := "M", 0
		for _, k := range []string{"A", "M", "D", "R"} {
			if kinds[k] > n {
				dom, n = k, kinds[k]
			}
		}
		var tasks mdChanges
		for _, mc := range md {
			tasks.checked = append(tasks.checked, mc.checked...)
			tasks.added = append(tasks.added, mc.added...)
			tasks.unchecked = append(tasks.unchecked, mc.unchecked...)
			tasks.removed = append(tasks.removed, mc.removed...)
		}
		switch {
		case n == len(files) && len(files) <= 3:
			subject = verb(dom) + " " + nameList(files, 3)
		case n == len(files):
			subject = verb(dom) + " " + plural(len(files), "fichier", "fichiers")
		default:
			var bits []string
			for _, k := range []string{"A", "M", "D", "R"} {
				if kinds[k] > 0 {
					label := map[string]string{"A": "ajoute", "M": "modifie", "D": "supprime", "R": "renomme"}[k]
					bits = append(bits, label+" "+strconv.Itoa(kinds[k]))
				}
			}
			subject = strings.Join(bits, ", ") + " fichiers"
			if len(files) <= 3 { // "ajoute list.js, met à jour TODO.md"
				var groups []string
				for _, k := range []string{"A", "M", "R", "D"} {
					var g []changedFile
					for _, f := range files {
						if f.Kind == k {
							g = append(g, f)
						}
					}
					if len(g) > 0 {
						groups = append(groups, verb(k)+" "+nameList(g, 3))
					}
				}
				subject = strings.Join(groups, ", ")
			}
		}
		if ts := taskSummary(&tasks); ts != "" && len(subject) < 40 {
			subject += " ; " + ts
		}
	}
	head := typ
	if scope != "" && len(scope) <= 20 {
		head += "(" + scope + ")"
	}
	subject = head + ": " + subject
	if len([]rune(subject)) > 72 {
		subject = string([]rune(subject)[:71]) + "…"
	}

	// body
	var body []string
	if len(files) > 1 {
		for i, f := range files {
			if i == 15 {
				body = append(body, fmt.Sprintf("- … et %d autre(s) fichier(s)", len(files)-15))
				break
			}
			stat := ""
			switch {
			case f.Binary:
				stat = " (binaire)"
			case f.Added+f.Removed > 0:
				stat = fmt.Sprintf(" (+%d −%d)", f.Added, f.Removed)
			}
			line := "- " + map[string]string{"A": "ajoute", "M": "modifie", "D": "supprime", "R": "renomme"}[f.Kind] + " " + f.Path
			if f.Kind == "R" {
				line = "- renomme " + f.Old + " → " + f.Path
			}
			body = append(body, line+stat)
		}
	}
	for _, f := range files {
		mc := md[f.Path]
		if mc == nil {
			continue
		}
		prefix := ""
		if len(md) > 1 || len(files) > 1 {
			prefix = path.Base(f.Path) + " : "
		}
		add := func(label string, items []string) {
			if len(items) > 0 {
				body = append(body, "- "+prefix+label+" "+quoteList(items, 5))
			}
		}
		if !(len(files) == 1 && len(mc.checked) == 1 && len(mc.added)+len(mc.unchecked)+len(mc.removed) == 0) {
			add("coché :", mc.checked)
		}
		if !(len(files) == 1 && len(mc.added) == 1 && len(mc.checked)+len(mc.unchecked)+len(mc.removed) == 0) {
			add("nouvelle(s) tâche(s) :", mc.added)
		}
		add("rouvert :", mc.unchecked)
		add("retiré :", mc.removed)
		add("nouvelle(s) section(s) :", mc.sectionsAdded)
		add("section(s) supprimée(s) :", mc.sectionsRemoved)
	}
	msg := subject
	if len(body) > 0 {
		msg += "\n\n" + strings.Join(body, "\n")
	}
	return map[string]any{"message": msg, "staged": stagedOnly, "files": len(files)}, nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func (a *App) registerCommitSuggest() {
	a.register("git.suggest", func(raw json.RawMessage) (any, error) {
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
		return suggestCommit(p.Path)
	})
}
