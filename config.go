package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type Command struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
	Cwd     string `json:"cwd,omitempty"`
}

type Project struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	Commands []*Command `json:"commands"`
	TodoFile string     `json:"todoFile,omitempty"`
}

type Config struct {
	Projects []*Project                 `json:"projects"`
	Active   string                     `json:"active"`
	Settings map[string]any             `json:"settings"`
	UI       map[string]json.RawMessage `json:"ui"`
}

type Store struct {
	mu   sync.Mutex
	path string
	cfg  Config
}

func newID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func loadStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "config.json")}
	data, err := os.ReadFile(s.path)
	if err == nil {
		if err := json.Unmarshal(data, &s.cfg); err != nil {
			// keep a copy of the broken file rather than losing it
			os.WriteFile(s.path+".broken", data, 0o644)
		}
	}
	if s.cfg.Settings == nil {
		s.cfg.Settings = map[string]any{}
	}
	if s.cfg.UI == nil {
		s.cfg.UI = map[string]json.RawMessage{}
	}
	for _, p := range s.cfg.Projects {
		if p.Commands == nil {
			p.Commands = []*Command{}
		}
	}
	if s.cfg.Projects == nil {
		s.cfg.Projects = []*Project{}
	}
	return s, nil
}

// saveLocked writes the config atomically. Caller holds s.mu.
func (s *Store) saveLocked() error {
	data, err := json.MarshalIndent(&s.cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) project(id string) (*Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.cfg.Projects {
		if p.ID == id {
			return p, nil
		}
	}
	return nil, errors.New("projet introuvable")
}

// resolve maps a project-relative path to an absolute path, refusing anything
// that escapes the project folder (lexically or through a symlink).
func (p *Project) resolve(rel string) (string, error) {
	rel = strings.TrimPrefix(filepath.ToSlash(rel), "/")
	root := filepath.Clean(p.Path)
	abs := filepath.Join(root, filepath.FromSlash(rel))
	if !within(root, abs) {
		return "", errors.New("chemin hors du projet")
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", errors.New("dossier du projet introuvable")
	}
	// check the deepest existing ancestor
	probe := abs
	for {
		if real, err := filepath.EvalSymlinks(probe); err == nil {
			if !within(realRoot, real) {
				return "", errors.New("lien symbolique hors du projet")
			}
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe || !within(root, parent) {
			break
		}
		probe = parent
	}
	return abs, nil
}

func within(root, p string) bool {
	r, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	return r == "." || (r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)))
}

func (p *Project) rel(abs string) string {
	r, err := filepath.Rel(p.Path, abs)
	if err != nil {
		return abs
	}
	return filepath.ToSlash(r)
}
