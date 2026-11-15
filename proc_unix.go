//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"
)

func shellCommand(line string) *exec.Cmd {
	sh := "/bin/sh"
	if _, err := os.Stat("/bin/bash"); err == nil {
		sh = "/bin/bash"
	}
	return exec.Command(sh, "-c", line)
}

func prepareCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func hideWindow(cmd *exec.Cmd) {}

func killTree(cmd *exec.Cmd) {
	pid := cmd.Process.Pid
	syscall.Kill(-pid, syscall.SIGINT)
	syscall.Kill(-pid, syscall.SIGTERM)
	go func() {
		time.Sleep(3 * time.Second)
		if cmd.ProcessState == nil {
			syscall.Kill(-pid, syscall.SIGKILL)
		}
	}()
}

// GUI-launched apps (Finder, desktop launchers) get a minimal PATH.
// Borrow the one from the user's login shell so npm, php, cargo… are found.
func fixPath() {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
		if _, err := os.Stat(shell); err != nil {
			shell = "/bin/bash"
		}
	}
	cmd := exec.Command(shell, "-l", "-i", "-c", `printf '__DASHPATH__%s__DASHPATH__' "$PATH"`)
	cmd.Stdin = nil
	done := make(chan []byte, 1)
	go func() {
		out, _ := cmd.Output()
		done <- out
	}()
	select {
	case out := <-done:
		s := string(out)
		if i := strings.Index(s, "__DASHPATH__"); i >= 0 {
			s = s[i+12:]
			if j := strings.Index(s, "__DASHPATH__"); j > 0 {
				merge(s[:j])
			}
		}
	case <-time.After(4 * time.Second):
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
	}
	// common locations, in case the shell profile is unusual
	home, _ := os.UserHomeDir()
	merge(strings.Join([]string{"/opt/homebrew/bin", "/usr/local/bin", home + "/.local/bin", home + "/.cargo/bin", home + "/go/bin", "/usr/local/go/bin", home + "/.composer/vendor/bin", home + "/.config/composer/vendor/bin"}, ":"))
}

func merge(extra string) {
	cur := strings.Split(os.Getenv("PATH"), ":")
	seen := map[string]bool{}
	for _, p := range cur {
		seen[p] = true
	}
	var add []string
	for _, p := range strings.Split(extra, ":") {
		if p == "" || seen[p] {
			continue
		}
		if st, err := os.Stat(p); err != nil || !st.IsDir() {
			continue
		}
		seen[p] = true
		add = append(add, p)
	}
	if len(add) > 0 {
		os.Setenv("PATH", strings.Join(append(add, cur...), ":"))
	}
}

func showError(title, msg string) {
	fmt.Fprintln(os.Stderr, title+": "+msg)
	if runtime.GOOS == "darwin" {
		q := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(msg)
		exec.Command("osascript", "-e", `display alert "`+title+`" message "`+q+`" as critical`).Run()
	} else if p, err := exec.LookPath("zenity"); err == nil {
		exec.Command(p, "--error", "--title="+title, "--text="+msg).Run()
	}
}

func openPath(p string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", p).Start()
	}
	return exec.Command("xdg-open", p).Start()
}
