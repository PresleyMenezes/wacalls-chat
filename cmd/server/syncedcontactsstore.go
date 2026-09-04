package main

import (
	"context"
	"database/sql"
	"time"
)

// SyncedContactRow mirrors a row in `synced_contacts` — a contact or group
// pulled directly from WhatsApp's own roster (via Store.Contacts or
// GetJoinedGroups), independent of whether any message has ever been
// exchanged. Exists specifically to let the operator call or message
// someone who has never sent a message into this system yet.
type SyncedContactRow struct {
	SessionID string
	ChatJID   string
	Name      string
	IsGroup   bool
	SyncedAt  int64
}

type syncedContactsStore struct{ db *sql.DB }

func newSyncedContactsStore(ctx context.Context, db *sql.DB) (*syncedContactsStore, error) {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS synced_contacts (
			session_id TEXT NOT NULL,
			chat_jid   TEXT NOT NULL,
			name       TEXT NOT NULL DEFAULT '',
			is_group   INTEGER NOT NULL DEFAULT 0,
			synced_at  INTEGER NOT NULL,
			PRIMARY KEY (session_id, chat_jid)
		)`,
	}
	for _, q := range stmts {
		if _, err := db.ExecContext(ctx, q); err != nil {
			return nil, err
		}
	}
	return &syncedContactsStore{db: db}, nil
}

// ReplaceAll swaps in a fresh roster for the session in one transaction —
// clears whatever was synced before and inserts the new set. Using
// REPLACE-all (not a merge) is intentional: contacts/groups the user has
// since removed on WhatsApp should also disappear from here, matching
// what a fresh sync would show.
func (s *syncedContactsStore) ReplaceAll(ctx context.Context, sessionID string, rows []SyncedContactRow) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM synced_contacts WHERE session_id = ?`, sessionID); err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO synced_contacts (session_id, chat_jid, name, is_group, synced_at) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	now := time.Now().UnixMilli()
	for _, r := range rows {
		isGroup := 0
		if r.IsGroup {
			isGroup = 1
		}
		if _, err := stmt.ExecContext(ctx, sessionID, r.ChatJID, r.Name, isGroup, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListBySession returns every synced contact/group for a connection,
// keyed by chat JID for cheap merging against message-derived chats.
func (s *syncedContactsStore) ListBySession(ctx context.Context, sessionID string) (map[string]SyncedContactRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT chat_jid, name, is_group, synced_at FROM synced_contacts WHERE session_id = ?`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]SyncedContactRow{}
	for rows.Next() {
		var r SyncedContactRow
		var isGroup int
		if err := rows.Scan(&r.ChatJID, &r.Name, &isGroup, &r.SyncedAt); err != nil {
			return nil, err
		}
		r.SessionID = sessionID
		r.IsGroup = isGroup == 1
		out[r.ChatJID] = r
	}
	return out, rows.Err()
}
