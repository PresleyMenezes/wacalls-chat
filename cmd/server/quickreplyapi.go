package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

func (s *server) registerQuickReplyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/quick-replies", s.requireAuth(s.handleQuickReplyList))
	mux.HandleFunc("POST /api/quick-replies", s.requireAuth(s.handleQuickReplyCreate))
	mux.HandleFunc("PUT /api/quick-replies/{id}", s.requireAuth(s.handleQuickReplyUpdate))
	mux.HandleFunc("DELETE /api/quick-replies/{id}", s.requireAuth(s.handleQuickReplyDelete))
}

// ownerScope returns the ID used to scope quick replies to a team: the
// tenant root's ID when the user belongs to a sub-account, otherwise the
// user's own ID. This makes replies shared across the whole company.
func ownerScope(u *currentUser) string {
	if u == nil {
		return ""
	}
	if t := u.TenantID(); t != "" {
		return t
	}
	return u.ID
}

func (s *server) handleQuickReplyList(w http.ResponseWriter, r *http.Request) {
	u := currentUserFromReq(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	rows, err := s.quickReplies.List(r.Context(), ownerScope(u))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"replies": rows})
}

func (s *server) handleQuickReplyCreate(w http.ResponseWriter, r *http.Request) {
	u := currentUserFromReq(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body struct {
		Shortcut string `json:"shortcut"`
		Text     string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	row, err := s.quickReplies.Insert(r.Context(), QuickReplyRow{
		Shortcut: body.Shortcut,
		Text:     body.Text,
		OwnerID:  ownerScope(u),
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reply": row})
}

func (s *server) handleQuickReplyUpdate(w http.ResponseWriter, r *http.Request) {
	u := currentUserFromReq(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body struct {
		Shortcut string `json:"shortcut"`
		Text     string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	row, err := s.quickReplies.Update(r.Context(), r.PathValue("id"), ownerScope(u), body.Shortcut, body.Text)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reply": row})
}

func (s *server) handleQuickReplyDelete(w http.ResponseWriter, r *http.Request) {
	u := currentUserFromReq(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if err := s.quickReplies.Delete(r.Context(), r.PathValue("id"), ownerScope(u)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
