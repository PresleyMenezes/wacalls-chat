package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

// QuickReplyRow is a saved canned-response template, triggered in the
// message composer by typing "/<shortcut>". Shared across the whole team
// (not per-user) so every attendant sees the same set.
type QuickReplyRow struct {
	ID        string `json:"id"`
	Shortcut  string `json:"shortcut"` // sem a barra "/", ex: "orcamento"
	Text      string `json:"text"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
	OwnerID   string `json:"-"`
}

type quickReplyStore struct{ db *sql.DB }

func newQuickReplyStore(ctx context.Context, db *sql.DB) (*quickReplyStore, error) {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS quick_replies (
		id         TEXT PRIMARY KEY,
		shortcut   TEXT NOT NULL,
		text       TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		owner_id   TEXT NOT NULL DEFAULT ''
	)`)
	if err != nil {
		return nil, err
	}
	_, _ = db.ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_replies_shortcut ON quick_replies(owner_id, shortcut)`)
	return &quickReplyStore{db: db}, nil
}

func newQuickReplyID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return "qr_" + hex.EncodeToString(b)
}

func normalizeShortcut(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "/")
	return strings.ToLower(s)
}

func (s *quickReplyStore) List(ctx context.Context, ownerID string) ([]QuickReplyRow, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, shortcut, text, created_at, updated_at, owner_id FROM quick_replies WHERE owner_id = ? ORDER BY shortcut ASC`,
		ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QuickReplyRow{}
	for rows.Next() {
		var r QuickReplyRow
		if err := rows.Scan(&r.ID, &r.Shortcut, &r.Text, &r.CreatedAt, &r.UpdatedAt, &r.OwnerID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *quickReplyStore) Insert(ctx context.Context, r QuickReplyRow) (QuickReplyRow, error) {
	r.Shortcut = normalizeShortcut(r.Shortcut)
	if r.Shortcut == "" {
		return r, errors.New("atalho vazio")
	}
	if strings.TrimSpace(r.Text) == "" {
		return r, errors.New("texto vazio")
	}
	now := time.Now().UnixMilli()
	r.ID = newQuickReplyID()
	r.CreatedAt = now
	r.UpdatedAt = now
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO quick_replies (id, shortcut, text, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)`,
		r.ID, r.Shortcut, r.Text, r.CreatedAt, r.UpdatedAt, r.OwnerID)
	if err != nil {
		return r, err
	}
	return r, nil
}

func (s *quickReplyStore) Update(ctx context.Context, id, ownerID, shortcut, text string) (QuickReplyRow, error) {
	shortcut = normalizeShortcut(shortcut)
	if shortcut == "" {
		return QuickReplyRow{}, errors.New("atalho vazio")
	}
	if strings.TrimSpace(text) == "" {
		return QuickReplyRow{}, errors.New("texto vazio")
	}
	now := time.Now().UnixMilli()
	res, err := s.db.ExecContext(ctx,
		`UPDATE quick_replies SET shortcut = ?, text = ?, updated_at = ? WHERE id = ? AND owner_id = ?`,
		shortcut, text, now, id, ownerID)
	if err != nil {
		return QuickReplyRow{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return QuickReplyRow{}, sql.ErrNoRows
	}
	return QuickReplyRow{ID: id, Shortcut: shortcut, Text: text, UpdatedAt: now, OwnerID: ownerID}, nil
}

func (s *quickReplyStore) Delete(ctx context.Context, id, ownerID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM quick_replies WHERE id = ? AND owner_id = ?`, id, ownerID)
	return err
}
