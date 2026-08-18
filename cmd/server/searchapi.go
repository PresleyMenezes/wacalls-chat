package main

import (
	"net/http"
	"strconv"
	"strings"
)

func (s *server) registerSearchRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/search/messages", s.requireAuth(s.handleSearchMessages))
}

type searchResultOut struct {
	SessionID string `json:"sessionId"`
	ChatJID   string `json:"chatJid"`
	ChatName  string `json:"chatName,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	MessageID string `json:"messageId"`
	Body      string `json:"body"`
	Kind      string `json:"kind"`
	Ts        int64  `json:"ts"`
	FromMe    bool   `json:"fromMe"`
}

// handleSearchMessages busca um trecho de texto em todas as conversas que o
// usuário autenticado pode ver (respeitando o mesmo escopo de conexões
// vinculadas usado no restante do sistema), retornando as ocorrências mais
// recentes primeiro, já com nome/avatar da conversa para exibição direta.
func (s *server) handleSearchMessages(w http.ResponseWriter, r *http.Request) {
	u := currentUserFromReq(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeJSON(w, http.StatusOK, map[string]any{"results": []searchResultOut{}})
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	visible := s.sessions.infosFor(u.ID, u.IsSuperAdmin())
	sessionIDs := make([]string, 0, len(visible))
	for _, si := range visible {
		sessionIDs = append(sessionIDs, si.ID)
	}
	if s.messages == nil || len(sessionIDs) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"results": []searchResultOut{}})
		return
	}
	rows, err := s.messages.Search(r.Context(), sessionIDs, query, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]searchResultOut, 0, len(rows))
	for _, row := range rows {
		item := searchResultOut{
			SessionID: row.SessionID,
			ChatJID:   row.ChatJID,
			MessageID: row.MessageID,
			Body:      row.Body,
			Kind:      row.Kind,
			Ts:        row.Ts,
			FromMe:    row.FromMe,
		}
		if s.chatMeta != nil {
			if meta, ok, merr := s.chatMeta.Get(r.Context(), row.SessionID, row.ChatJID); merr == nil && ok {
				item.ChatName = meta.Name
				item.AvatarURL = meta.AvatarURL
			}
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": out})
}
