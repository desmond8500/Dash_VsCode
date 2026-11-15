package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const appName = "DashLite"

func main() {
	port := flag.Int("port", 4777, "port HTTP préféré (un autre est choisi s'il est occupé)")
	noBrowser := flag.Bool("no-browser", false, "ne pas ouvrir de fenêtre ; le serveur reste actif jusqu'à Ctrl+C")
	dataFlag := flag.String("data", "", "dossier de configuration (par défaut : dossier utilisateur, ou DashLite-data à côté de l'exécutable)")
	browserMode := flag.String("browser", "app", "app = fenêtre d'application Chrome/Edge, default = navigateur par défaut")
	version := flag.Bool("version", false, "afficher la version")
	restarted := flag.Bool("restarted", false, "usage interne : relance après une mise à jour")
	flag.Parse()
	if *version {
		fmt.Println(appName, appVersion)
		return
	}

	dataDir := resolveDataDir(*dataFlag)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		fatal("Impossible de créer le dossier de données :\n" + dataDir + "\n\n" + err.Error())
	}
	setupLog(dataDir)
	log.Printf("%s %s — données : %s", appName, appVersion, dataDir)

	cleanupOldBinaries()

	// Already running? Just bring up a window on the existing instance.
	if url, ok := existingInstance(*port); ok && !*restarted {
		log.Printf("instance existante sur %s", url)
		if !*noBrowser {
			openWindow(url, dataDir, *browserMode)
		} else {
			fmt.Println("Déjà lancé :", url)
		}
		return
	}

	fixPath()

	store, err := loadStore(dataDir)
	if err != nil {
		fatal("Configuration illisible :\n" + err.Error())
	}
	tok := make([]byte, 24)
	rand.Read(tok)
	hub := newHub()
	app := &App{
		store:    store,
		token:    hex.EncodeToString(tok),
		dataDir:  dataDir,
		hub:      hub,
		sessions: newSessions(hub),
		handlers: map[string]func(json.RawMessage) (any, error){},
		quit:     make(chan struct{}),
	}
	app.registerCore()
	app.registerFS()
	app.registerRuns()
	app.registerGit()
	app.registerCommands()
	app.registerBrowserHelpers()
	app.registerShortcut()
	app.registerCommitSuggest()
	app.registerConflicts()
	app.updater = &Updater{app: app}
	app.registerUpdate()

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	for i := 0; err != nil && *restarted && i < 40; i++ {
		// the previous version is still releasing the port
		time.Sleep(250 * time.Millisecond)
		ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	}
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal("Impossible d'ouvrir un port local :\n" + err.Error())
		}
	}
	app.port = ln.Addr().(*net.TCPAddr).Port
	url := fmt.Sprintf("http://127.0.0.1:%d/", app.port)
	srv := &http.Server{Handler: app, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("serveur : %v", err)
		}
	}()
	log.Printf("prêt sur %s", url)
	fmt.Println(appName, "→", url)

	if !*noBrowser {
		if !*restarted { // after an update the open window reconnects by itself
			openWindow(url, dataDir, *browserMode)
		}
		go app.watchIdle()
	}
	go app.updater.loop()
	<-app.quit
	log.Printf("arrêt")
	srv.Close()
	ln.Close()
	if app.restart {
		if err := app.spawnRestart(); err != nil {
			log.Printf("redémarrage impossible : %v", err)
		}
	}
}

// Quit once the window has been closed for a while (page reloads reconnect in ~1 s).
func (a *App) watchIdle() {
	start := time.Now()
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for range t.C {
		count, ever, since := a.hub.status()
		if ever && count == 0 && since > 12*time.Second {
			log.Printf("fenêtre fermée : arrêt")
			a.shutdown()
			return
		}
		if !ever && time.Since(start) > 3*time.Minute {
			log.Printf("aucune fenêtre ne s'est connectée : arrêt")
			a.shutdown()
			return
		}
	}
}

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	dir := filepath.Dir(exe)
	// inside a macOS bundle: DashLite.app/Contents/MacOS → folder holding the .app
	if runtime.GOOS == "darwin" && strings.HasSuffix(dir, ".app/Contents/MacOS") {
		dir = filepath.Dir(filepath.Dir(filepath.Dir(dir)))
	}
	return dir
}

func resolveDataDir(flagVal string) string {
	if flagVal != "" {
		return expandHome(flagVal)
	}
	if env := os.Getenv("DASHLITE_DATA"); env != "" {
		return expandHome(env)
	}
	// portable mode: a "DashLite-data" folder next to the executable
	if d := exeDir(); d != "" {
		p := filepath.Join(d, appName+"-data")
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p
		}
	}
	base, err := os.UserConfigDir()
	if err != nil {
		home, _ := os.UserHomeDir()
		base = home
	}
	return filepath.Join(base, appName)
}

func setupLog(dir string) {
	p := filepath.Join(dir, "dashlite.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 1<<20 {
		os.Rename(p, p+".old")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	log.SetOutput(io.MultiWriter(f, os.Stderr))
}

func existingInstance(port int) (string, bool) {
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)
	c := http.Client{Timeout: 800 * time.Millisecond}
	resp, err := c.Get(url + "api/ping")
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	var v struct{ App string }
	if json.NewDecoder(resp.Body).Decode(&v) != nil || v.App != "dashlite" {
		return "", false
	}
	return url, true
}

// ---------------------------------------------------------------- window

func chromiumCandidates() []string {
	var c []string
	switch runtime.GOOS {
	case "windows":
		pf, pf86, local := os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LocalAppData")
		for _, base := range []string{pf, pf86, local} {
			if base == "" {
				continue
			}
			c = append(c, filepath.Join(base, `Google\Chrome\Application\chrome.exe`))
		}
		for _, base := range []string{pf86, pf, local} {
			if base == "" {
				continue
			}
			c = append(c, filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`))
		}
		for _, base := range []string{pf, local} {
			if base != "" {
				c = append(c, filepath.Join(base, `BraveSoftware\Brave-Browser\Application\brave.exe`))
			}
		}
	case "darwin":
		home, _ := os.UserHomeDir()
		for _, app := range []string{"Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Vivaldi"} {
			bin := app
			c = append(c, "/Applications/"+app+".app/Contents/MacOS/"+bin, home+"/Applications/"+app+".app/Contents/MacOS/"+bin)
		}
	default:
		for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser", "vivaldi"} {
			if p, err := exec.LookPath(name); err == nil {
				c = append(c, p)
			}
		}
	}
	return c
}

func openWindow(url, dataDir, mode string) {
	if mode != "default" {
		for _, exe := range chromiumCandidates() {
			if _, err := os.Stat(exe); err != nil {
				continue
			}
			args := []string{
				"--app=" + url,
				"--user-data-dir=" + filepath.Join(dataDir, "window"),
				"--no-first-run", "--no-default-browser-check",
				"--window-size=1440,900",
				"--disable-features=Translate,TranslateUI",
			}
			cmd := exec.Command(exe, args...)
			if err := cmd.Start(); err == nil {
				log.Printf("fenêtre : %s", exe)
				go cmd.Wait()
				return
			}
		}
	}
	openDefault(url)
}

func openDefault(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	case "darwin":
		cmd = exec.Command("open", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	return cmd.Start()
}

// Small helpers the UI uses to hand things over to the OS.
func (a *App) registerBrowserHelpers() {
	a.register("os.reveal", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct {
			P    string `json:"p"`
			Path string `json:"path"`
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
		var cmd *exec.Cmd
		switch runtime.GOOS {
		case "windows":
			cmd = exec.Command("explorer", "/select,", abs)
			if st, err := os.Stat(abs); err == nil && st.IsDir() {
				cmd = exec.Command("explorer", abs)
			}
		case "darwin":
			cmd = exec.Command("open", "-R", abs)
		default:
			dir := abs
			if st, err := os.Stat(abs); err == nil && !st.IsDir() {
				dir = filepath.Dir(abs)
			}
			return nil, openPath(dir)
		}
		return nil, cmd.Start()
	})

	a.register("os.openUrl", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ URL string }](raw)
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(req.URL, "https://") && !strings.HasPrefix(req.URL, "http://") {
			return nil, badRequest("seuls les liens http(s) peuvent être ouverts")
		}
		return nil, openDefault(req.URL)
	})

	a.register("os.openFolder", func(raw json.RawMessage) (any, error) {
		req, err := bind[struct{ Which string }](raw)
		if err != nil {
			return nil, err
		}
		if req.Which != "data" {
			return nil, badRequest("dossier inconnu")
		}
		return nil, openPath(a.dataDir)
	})
}

func fatal(msg string) {
	log.Print(msg)
	showError(appName, msg)
	os.Exit(1)
}

// Linux: adds Dash Lite to the applications menu (absolute path to this executable).
func (a *App) registerShortcut() {
	a.register("os.shortcut", func(json.RawMessage) (any, error) {
		if runtime.GOOS != "linux" {
			return nil, badRequest("disponible uniquement sous Linux")
		}
		exe, err := currentExe()
		if err != nil {
			return nil, err
		}
		home, _ := os.UserHomeDir()
		appsDir := filepath.Join(home, ".local", "share", "applications")
		if err := os.MkdirAll(appsDir, 0o755); err != nil {
			return nil, err
		}
		icon, _ := webFS.ReadFile("web/icon.svg")
		iconPath := filepath.Join(a.dataDir, "dashlite.svg")
		os.WriteFile(iconPath, icon, 0o644)
		quoted := `"` + strings.ReplaceAll(exe, `"`, `\"`) + `"`
		desktop := "[Desktop Entry]\nType=Application\nName=Dash Lite\nComment=Éditeur léger multi-projets\nExec=" + quoted +
			"\nIcon=" + iconPath + "\nTerminal=false\nCategories=Development;TextEditor;\nStartupNotify=false\n"
		path := filepath.Join(appsDir, "dashlite.desktop")
		if err := os.WriteFile(path, []byte(desktop), 0o755); err != nil {
			return nil, err
		}
		return map[string]string{"path": path}, nil
	})
}
