package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

type detected struct {
	Name    string `json:"name"`
	Command string `json:"command"`
	Cwd     string `json:"cwd"`
	Source  string `json:"source"`
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func anyGlob(dir string, patterns ...string) string {
	for _, pat := range patterns {
		if m, _ := filepath.Glob(filepath.Join(dir, pat)); len(m) > 0 {
			return filepath.Base(m[0])
		}
	}
	return ""
}

var makeTargetRe = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9_.\-/]*)\s*:`)
var justRecipeRe = regexp.MustCompile(`^@?([A-Za-z0-9_][A-Za-z0-9_\-]*)(?:\s+[^:=]*)?:(?:[^=]|$)`)

// detectDir lists the commands a folder obviously supports, whatever the stack.
func detectDir(dir, rel string) []detected {
	var out []detected
	add := func(source, name, command string) {
		out = append(out, detected{Name: name, Command: command, Cwd: rel, Source: source})
	}
	win := runtime.GOOS == "windows"

	// JavaScript / TypeScript
	if data, err := os.ReadFile(filepath.Join(dir, "package.json")); err == nil {
		var pkg struct {
			Scripts map[string]string `json:"scripts"`
		}
		json.Unmarshal(data, &pkg)
		pm, run := "npm", "npm run "
		switch {
		case exists(filepath.Join(dir, "pnpm-lock.yaml")):
			pm, run = "pnpm", "pnpm "
		case exists(filepath.Join(dir, "yarn.lock")):
			pm, run = "yarn", "yarn "
		case exists(filepath.Join(dir, "bun.lockb")) || exists(filepath.Join(dir, "bun.lock")):
			pm, run = "bun", "bun run "
		}
		add("package.json", pm+" install", pm+" install")
		names := make([]string, 0, len(pkg.Scripts))
		for k := range pkg.Scripts {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			add("package.json", k, run+k)
		}
	}
	if data, err := os.ReadFile(filepath.Join(dir, "deno.json")); err == nil {
		var d struct {
			Tasks map[string]any `json:"tasks"`
		}
		json.Unmarshal(data, &d)
		for k := range d.Tasks {
			add("deno.json", k, "deno task "+k)
		}
	}

	// PHP
	if data, err := os.ReadFile(filepath.Join(dir, "composer.json")); err == nil {
		var c struct {
			Scripts map[string]any `json:"scripts"`
		}
		json.Unmarshal(data, &c)
		add("composer.json", "composer install", "composer install")
		add("composer.json", "composer update", "composer update")
		names := make([]string, 0)
		for k := range c.Scripts {
			if !strings.HasPrefix(k, "pre-") && !strings.HasPrefix(k, "post-") {
				names = append(names, k)
			}
		}
		sort.Strings(names)
		for _, k := range names {
			add("composer.json", k, "composer run-script "+k)
		}
	}
	if exists(filepath.Join(dir, "artisan")) {
		for _, c := range []string{"serve", "migrate", "migrate:fresh --seed", "test", "optimize:clear", "queue:work", "route:list"} {
			add("Laravel", "artisan "+c, "php artisan "+c)
		}
	}
	if exists(filepath.Join(dir, "bin", "console")) && exists(filepath.Join(dir, "symfony.lock")) {
		add("Symfony", "cache:clear", "php bin/console cache:clear")
		add("Symfony", "symfony serve", "symfony serve")
	}

	// Python
	if exists(filepath.Join(dir, "requirements.txt")) {
		add("Python", "pip install", "pip install -r requirements.txt")
	}
	if exists(filepath.Join(dir, "pyproject.toml")) {
		if exists(filepath.Join(dir, "uv.lock")) {
			add("Python", "uv sync", "uv sync")
		} else if exists(filepath.Join(dir, "poetry.lock")) {
			add("Python", "poetry install", "poetry install")
		} else {
			add("Python", "pip install -e .", "pip install -e .")
		}
	}
	if exists(filepath.Join(dir, "manage.py")) {
		add("Django", "runserver", "python manage.py runserver")
		add("Django", "migrate", "python manage.py migrate")
		add("Django", "test", "python manage.py test")
	}
	if exists(filepath.Join(dir, "pytest.ini")) || exists(filepath.Join(dir, "tests")) && (exists(filepath.Join(dir, "pyproject.toml")) || exists(filepath.Join(dir, "requirements.txt"))) {
		add("Python", "pytest", "pytest")
	}

	// Go, Rust
	if exists(filepath.Join(dir, "go.mod")) {
		add("Go", "go build", "go build ./...")
		add("Go", "go run", "go run .")
		add("Go", "go test", "go test ./...")
		add("Go", "go mod tidy", "go mod tidy")
	}
	if exists(filepath.Join(dir, "Cargo.toml")) {
		add("Rust", "cargo build", "cargo build")
		add("Rust", "cargo build --release", "cargo build --release")
		add("Rust", "cargo run", "cargo run")
		add("Rust", "cargo test", "cargo test")
	}

	// .NET, Java, Kotlin
	if f := anyGlob(dir, "*.sln", "*.csproj", "*.fsproj", "*.vbproj"); f != "" {
		add(".NET", "dotnet build", "dotnet build")
		add(".NET", "dotnet run", "dotnet run")
		add(".NET", "dotnet test", "dotnet test")
		add(".NET", "dotnet publish", "dotnet publish -c Release")
	}
	if exists(filepath.Join(dir, "pom.xml")) {
		mvn := "mvn"
		if exists(filepath.Join(dir, "mvnw")) {
			mvn = "./mvnw"
			if win {
				mvn = "mvnw.cmd"
			}
		}
		add("Maven", "package", mvn+" package")
		add("Maven", "test", mvn+" test")
		add("Maven", "clean install", mvn+" clean install")
	}
	if exists(filepath.Join(dir, "build.gradle")) || exists(filepath.Join(dir, "build.gradle.kts")) || exists(filepath.Join(dir, "settings.gradle")) {
		g := "gradle"
		if exists(filepath.Join(dir, "gradlew")) {
			g = "./gradlew"
			if win {
				g = "gradlew.bat"
			}
		}
		add("Gradle", "build", g+" build")
		add("Gradle", "test", g+" test")
		add("Gradle", "clean", g+" clean")
		if exists(filepath.Join(dir, "app", "src", "main", "AndroidManifest.xml")) {
			add("Android", "assembleDebug", g+" assembleDebug")
		}
	}

	// Flutter / Dart
	if data, err := os.ReadFile(filepath.Join(dir, "pubspec.yaml")); err == nil {
		if strings.Contains(string(data), "flutter:") {
			add("Flutter", "flutter pub get", "flutter pub get")
			add("Flutter", "flutter run", "flutter run")
			add("Flutter", "flutter build apk", "flutter build apk")
			add("Flutter", "flutter test", "flutter test")
		} else {
			add("Dart", "dart pub get", "dart pub get")
			add("Dart", "dart run", "dart run")
			add("Dart", "dart test", "dart test")
		}
	}

	// Ruby
	if exists(filepath.Join(dir, "Gemfile")) {
		add("Ruby", "bundle install", "bundle install")
		if exists(filepath.Join(dir, "bin", "rails")) {
			add("Rails", "rails server", "bin/rails server")
			add("Rails", "db:migrate", "bin/rails db:migrate")
		}
	}

	// Containers
	if f := anyGlob(dir, "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"); f != "" {
		add("Docker", "compose up", "docker compose up -d")
		add("Docker", "compose down", "docker compose down")
		add("Docker", "compose logs", "docker compose logs -f --tail=200")
		add("Docker", "compose build", "docker compose build")
	} else if exists(filepath.Join(dir, "Dockerfile")) {
		name := strings.ToLower(strings.ReplaceAll(filepath.Base(dir), " ", "-"))
		add("Docker", "docker build", "docker build -t "+name+" .")
	}

	// Task runners
	for _, mf := range []string{"Makefile", "makefile", "GNUmakefile"} {
		f, err := os.Open(filepath.Join(dir, mf))
		if err != nil {
			continue
		}
		seen := map[string]bool{}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := sc.Text()
			m := makeTargetRe.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			rest := line[len(m[0]):]
			if strings.HasPrefix(rest, "=") || strings.HasPrefix(m[1], ".") || strings.Contains(m[1], "%") || seen[m[1]] {
				continue
			}
			seen[m[1]] = true
			add("Makefile", m[1], "make "+m[1])
		}
		f.Close()
		break
	}
	for _, jf := range []string{"justfile", "Justfile", ".justfile"} {
		f, err := os.Open(filepath.Join(dir, jf))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "#") || strings.Contains(line, ":=") {
				continue
			}
			if m := justRecipeRe.FindStringSubmatch(line); m != nil && m[1] != "set" && m[1] != "export" && m[1] != "alias" {
				add("justfile", m[1], "just "+m[1])
			}
		}
		f.Close()
		break
	}
	// plain scripts at the root
	scripts := []string{"*.sh"}
	if win {
		scripts = []string{"*.bat", "*.cmd", "*.ps1"}
	}
	for _, pat := range scripts {
		m, _ := filepath.Glob(filepath.Join(dir, pat))
		for _, s := range m {
			b := filepath.Base(s)
			switch {
			case strings.HasSuffix(b, ".ps1"):
				add("Scripts", b, `powershell -ExecutionPolicy Bypass -File "`+b+`"`)
			case win:
				add("Scripts", b, b)
			default:
				add("Scripts", b, "sh ./"+b)
			}
		}
	}
	return out
}

func detectCommands(root string) []detected {
	out := detectDir(root, "")
	// one level down, for monorepos (api/ + front/, backend/ + mobile/…)
	des, err := os.ReadDir(root)
	if err != nil {
		return out
	}
	for _, d := range des {
		if !d.IsDir() || strings.HasPrefix(d.Name(), ".") || heavyDirs[d.Name()] {
			continue
		}
		sub := detectDir(filepath.Join(root, d.Name()), d.Name())
		// a "Scripts" entry alone is noise for subfolders
		keep := sub[:0]
		for _, x := range sub {
			if x.Source != "Scripts" {
				keep = append(keep, x)
			}
		}
		out = append(out, keep...)
	}
	return out
}

func (a *App) registerCommands() {
	a.register("cmds.list", func(raw json.RawMessage) (any, error) {
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
		a.store.mu.Lock()
		saved := append([]*Command{}, p.Commands...)
		a.store.mu.Unlock()
		det := detectCommands(p.Path)
		if det == nil {
			det = []detected{}
		}
		return map[string]any{"saved": saved, "detected": det}, nil
	})

	a.register("cmds.save", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P   string  `json:"p"`
			Cmd Command `json:"cmd"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		c := req.Cmd
		c.Name = strings.TrimSpace(c.Name)
		c.Command = strings.TrimSpace(c.Command)
		c.Cwd = strings.Trim(strings.TrimSpace(filepath.ToSlash(c.Cwd)), "/")
		if c.Command == "" {
			return nil, badRequest("ligne de commande vide")
		}
		if c.Name == "" {
			c.Name = c.Command
		}
		if _, err := p.resolve(c.Cwd); err != nil {
			return nil, badRequest("sous-dossier invalide : %v", err)
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		if c.ID != "" {
			for i, x := range p.Commands {
				if x.ID == c.ID {
					p.Commands[i] = &c
					return &c, a.store.saveLocked()
				}
			}
		}
		c.ID = newID()
		p.Commands = append(p.Commands, &c)
		return &c, a.store.saveLocked()
	})

	a.register("cmds.delete", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P  string `json:"p"`
			ID string `json:"id"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		list := p.Commands[:0]
		for _, x := range p.Commands {
			if x.ID != req.ID {
				list = append(list, x)
			}
		}
		p.Commands = list
		return nil, a.store.saveLocked()
	})

	a.register("cmds.move", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P     string `json:"p"`
			ID    string `json:"id"`
			Delta int    `json:"delta"`
		}](raw)
		if err != nil {
			return nil, err
		}
		p, err := a.proj(req.P)
		if err != nil {
			return nil, err
		}
		a.store.mu.Lock()
		defer a.store.mu.Unlock()
		l := p.Commands
		for i, x := range l {
			if x.ID == req.ID {
				if j := i + req.Delta; j >= 0 && j < len(l) {
					l[i], l[j] = l[j], l[i]
				}
				break
			}
		}
		return nil, a.store.saveLocked()
	})
}
