package main

import (
	"encoding/json"
	"net/http"
)

func (s *server) registerKanbanRoutes(mux *http.ServeMux) {
	// Boards
	mux.HandleFunc("GET /api/kanban/boards", s.requireAuth(s.handleKBBoardList))
	mux.HandleFunc("POST /api/kanban/boards", s.requireAuth(s.handleKBBoardCreate))
	mux.HandleFunc("GET /api/kanban/boards/{id}", s.requireAuth(s.handleKBBoardGet))
	mux.HandleFunc("PUT /api/kanban/boards/{id}", s.requireAuth(s.handleKBBoardUpdate))
	mux.HandleFunc("DELETE /api/kanban/boards/{id}", s.requireAuth(s.handleKBBoardDelete))

	// Columns (nested under board for creation; per-id for mutations).
	mux.HandleFunc("POST /api/kanban/boards/{id}/columns", s.requireAuth(s.handleKBColumnCreate))
	mux.HandleFunc("PUT /api/kanban/columns/{id}", s.requireAuth(s.handleKBColumnUpdate))
	mux.HandleFunc("DELETE /api/kanban/columns/{id}", s.requireAuth(s.handleKBColumnDelete))

	// Cards
	mux.HandleFunc("POST /api/kanban/boards/{id}/cards", s.requireAuth(s.handleKBCardCreate))
	mux.HandleFunc("PUT /api/kanban/cards/{id}", s.requireAuth(s.handleKBCardUpdate))
	mux.HandleFunc("POST /api/kanban/cards/{id}/move", s.requireAuth(s.handleKBCardMove))
	mux.HandleFunc("DELETE /api/kanban/cards/{id}", s.requireAuth(s.handleKBCardDelete))

	// Automations
	mux.HandleFunc("GET /api/kanban/boards/{id}/automations", s.requireAuth(s.handleKBAutomList))
	mux.HandleFunc("POST /api/kanban/boards/{id}/automations", s.requireAuth(s.handleKBAutomUpsert))
	mux.HandleFunc("DELETE /api/kanban/automations/{id}", s.requireAuth(s.handleKBAutomDelete))

	// Lookup: which cards reference the current chat. Used by ChatView to
	// surface the linked kanban entries inline.
	mux.HandleFunc("GET /api/kanban/cards/by-chat", s.requireAuth(s.handleKBCardsByChat))
}

// kanbanScope descreve o que o usuário atual enxerga no Kanban.
//
// Hierarquia:
//   - dono da empresa (conta raiz) e super admin: todos os quadros/equipes;
//   - administrador de equipe: os quadros das equipes às quais está vinculado,
//     e pode criar, editar e apagar esses quadros;
//   - atendente: só os quadros das equipes às quais está vinculado, sem poder
//     editar o quadro (mover cartões continua permitido).
type kanbanScope struct {
	user  *currentUser
	all   bool            // dono da empresa ou super admin
	teams map[string]bool // equipes (filas) vinculadas ao usuário
}

func (s *server) kanbanScopeFor(r *http.Request) (kanbanScope, bool) {
	u := currentUserFromReq(r)
	if u == nil {
		return kanbanScope{}, false
	}
	sc := kanbanScope{user: u, teams: map[string]bool{}}
	sc.all = u.IsSuperAdmin() || u.ParentID == ""
	if ids, err := s.auth.QueuesFor(r.Context(), u.ID); err == nil {
		for _, id := range ids {
			sc.teams[id] = true
		}
	}
	return sc, true
}

// canView: pode abrir o quadro e mexer nos cartões.
func (sc kanbanScope) canView(b kanbanBoard) bool {
	if sc.user == nil {
		return false
	}
	if sc.user.IsSuperAdmin() {
		return true
	}
	// Isolamento por empresa: boards são persistidos contra a raiz do tenant.
	if b.OwnerID != "" && b.OwnerID != sc.user.TenantID() {
		return false
	}
	if sc.all {
		return true
	}
	return b.QueueID != "" && sc.teams[b.QueueID]
}

// canManage: pode editar/apagar o quadro, suas colunas e automações.
func (sc kanbanScope) canManage(b kanbanBoard) bool {
	if !sc.canView(b) {
		return false
	}
	return sc.all || sc.user.IsAdmin()
}

// canUseTeam: pode vincular quadros a esta equipe.
func (sc kanbanScope) canUseTeam(teamID string) bool {
	if teamID == "" {
		return false
	}
	return sc.all || (sc.user.IsAdmin() && sc.teams[teamID])
}

// canManageBoard centraliza a checagem usada por todo endpoint que altera o
// quadro em si (nome, colunas, automações).
func (s *server) canManageBoard(r *http.Request, boardID string) bool {
	return s.boardAllowed(r, boardID, true)
}

// canViewBoard é a checagem para abrir o quadro e mexer nos cartões.
func (s *server) canViewBoard(r *http.Request, boardID string) bool {
	return s.boardAllowed(r, boardID, false)
}

func (s *server) boardAllowed(r *http.Request, boardID string, manage bool) bool {
	sc, ok := s.kanbanScopeFor(r)
	if !ok {
		return false
	}
	b, err := s.kanban.GetBoard(r.Context(), boardID)
	if err != nil {
		return false
	}
	if manage {
		return sc.canManage(b)
	}
	return sc.canView(b)
}

// teamBelongsToTenant confirma que a equipe (fila) existe e é da empresa do usuário.
func (s *server) teamBelongsToTenant(r *http.Request, sc kanbanScope, teamID string) bool {
	if sc.user.IsSuperAdmin() {
		return true
	}
	q, err := s.queues.Get(r.Context(), teamID)
	if err != nil {
		return false
	}
	return q.OwnerID == sc.user.TenantID()
}

// ----- boards -----

func (s *server) handleKBBoardList(w http.ResponseWriter, r *http.Request) {
	sc, ok := s.kanbanScopeFor(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	all, err := s.kanban.ListBoards(r.Context(), sc.user.TenantID(), sc.user.IsSuperAdmin())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	rows := make([]kanbanBoard, 0, len(all))
	for _, b := range all {
		if sc.canView(b) {
			rows = append(rows, b)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"boards": rows})
}

func (s *server) handleKBBoardCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name, Color, Description string
		QueueID                  string `json:"queueId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	sc, ok := s.kanbanScopeFor(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	u := sc.user
	if body.QueueID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "selecione a equipe do quadro"})
		return
	}
	if !sc.canUseTeam(body.QueueID) || !s.teamBelongsToTenant(r, sc, body.QueueID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "sem permissão para criar quadros nesta equipe"})
		return
	}
	// Persistido contra a raiz do tenant (não o usuário individual), para
	// que todo admin/operador da mesma empresa veja o board, independente
	// de quem o criou — mesmo padrão já usado em Filas.
	b, err := s.kanban.CreateBoard(r.Context(), body.Name, body.Color, body.Description, u.TenantID(), body.QueueID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (s *server) handleKBBoardGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.canViewBoard(r, id) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	board, err := s.kanban.GetBoard(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	cols, err := s.kanban.ListColumns(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Materialize a card for every active chat (atendimento) the user can
	// see that doesn't yet have one on this board, so the board reflects
	// the conversation queue out-of-the-box instead of staying empty.
	if u := currentUserFromReq(r); u != nil {
		s.backfillKanbanCards(r.Context(), id, cols, u.ID, u.IsSuperAdmin())
	}
	cards, err := s.kanban.ListCards(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	autom, _ := s.kanban.ListAutomations(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"board": board, "columns": cols, "cards": cards, "automations": autom})
}

func (s *server) handleKBBoardUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.canManageBoard(r, id) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	var body struct {
		Name, Color, Description string
		QueueID                  string `json:"queueId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.QueueID != "" {
		sc, ok := s.kanbanScopeFor(r)
		if !ok || !sc.canUseTeam(body.QueueID) || !s.teamBelongsToTenant(r, sc, body.QueueID) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "sem permissão para esta equipe"})
			return
		}
	}
	if err := s.kanban.UpdateBoard(r.Context(), id, body.Name, body.Color, body.Description, body.QueueID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleKBBoardDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.canManageBoard(r, id) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if err := s.kanban.DeleteBoard(r.Context(), id); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ----- columns -----

func (s *server) handleKBColumnCreate(w http.ResponseWriter, r *http.Request) {
	boardID := r.PathValue("id")
	if !s.canManageBoard(r, boardID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	var body struct{ Name, Color, StageType string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	c, err := s.kanban.CreateColumn(r.Context(), boardID, body.Name, body.Color, body.StageType)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *server) handleKBColumnUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	col, err := s.kanban.GetColumn(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if !s.canManageBoard(r, col.BoardID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	var body struct{ Name, Color, StageType string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.StageType == "" {
		body.StageType = col.StageType
	}
	if err := s.kanban.UpdateColumn(r.Context(), id, body.Name, body.Color, body.StageType); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleKBColumnDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	col, err := s.kanban.GetColumn(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if !s.canManageBoard(r, col.BoardID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if err := s.kanban.DeleteColumn(r.Context(), id); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ----- cards -----

func (s *server) handleKBCardCreate(w http.ResponseWriter, r *http.Request) {
	boardID := r.PathValue("id")
	if !s.canViewBoard(r, boardID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	var body struct {
		ColumnID, Title, Description, Color string
		SessionID, ChatJID, AssigneeID      string
		DueAt                               int64
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	// A coluna informada precisa pertencer a ESTE board — senão o cartão
	// nasceria com board_id de uma empresa e column_id de outra.
	col, err := s.kanban.GetColumn(r.Context(), body.ColumnID)
	if err != nil || col.BoardID != boardID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "coluna inválida para este board"})
		return
	}
	c, err := s.kanban.CreateCard(r.Context(), cardCreate{
		BoardID: boardID, ColumnID: body.ColumnID, Title: body.Title,
		Description: body.Description, Color: body.Color,
		SessionID: body.SessionID, ChatJID: body.ChatJID,
		AssigneeID: body.AssigneeID, DueAt: body.DueAt,
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *server) handleKBCardUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	card, err := s.kanban.GetCard(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if !s.canViewBoard(r, card.BoardID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	var body struct {
		Title, Description, Color      *string
		AssigneeID, ChatJID, SessionID *string
		DueAt                          *int64
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := s.kanban.UpdateCard(r.Context(), id, cardUpdate{
		Title: body.Title, Description: body.Description, Color: body.Color,
		AssigneeID: body.AssigneeID, ChatJID: body.ChatJID, SessionID: body.SessionID,
		DueAt: body.DueAt,
	}); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleKBCardMove(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	card, err := s.kanban.GetCard(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if !s.canViewBoard(r, card.BoardID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	var body struct {
		ColumnID string `json:"columnId"`
		Position int    `json:"position"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	// A coluna de destino precisa pertencer ao MESMO board do cartão — sem
	// isso, um cartão poderia ser movido para a coluna de um board de outra
	// empresa (vazamento/corrupção entre empresas).
	col, err := s.kanban.GetColumn(r.Context(), body.ColumnID)
	if err != nil || col.BoardID != card.BoardID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "coluna inválida para este board"})
		return
	}
	if err := s.kanban.MoveCard(r.Context(), id, body.ColumnID, body.Position); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleKBCardDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	card, err := s.kanban.GetCard(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if !s.canViewBoard(r, card.BoardID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if err := s.kanban.DeleteCard(r.Context(), id); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleKBCardsByChat(w http.ResponseWriter, r *http.Request) {
	sid := r.URL.Query().Get("sid")
	jid := r.URL.Query().Get("jid")
	if sid == "" || jid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sid and jid required"})
		return
	}
	cards, err := s.kanban.CardsByChat(r.Context(), sid, jid)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Só devolve cartões de quadros que o usuário pode ver.
	if sc, ok := s.kanbanScopeFor(r); ok {
		visible := make([]kanbanCard, 0, len(cards))
		for _, c := range cards {
			if b, err := s.kanban.GetBoard(r.Context(), c.BoardID); err == nil && sc.canView(b) {
				visible = append(visible, c)
			}
		}
		cards = visible
	}
	writeJSON(w, http.StatusOK, map[string]any{"cards": cards})
}

// ----- automations -----

func (s *server) handleKBAutomList(w http.ResponseWriter, r *http.Request) {
	boardID := r.PathValue("id")
	if !s.canManageBoard(r, boardID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	rows, err := s.kanban.ListAutomations(r.Context(), boardID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"automations": rows})
}

func (s *server) handleKBAutomUpsert(w http.ResponseWriter, r *http.Request) {
	boardID := r.PathValue("id")
	if !s.canManageBoard(r, boardID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	var body kanbanAutomation
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	body.BoardID = boardID
	out, err := s.kanban.UpsertAutomation(r.Context(), body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) handleKBAutomDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	boardID, err := s.kanban.GetAutomationBoardID(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if !s.canManageBoard(r, boardID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if err := s.kanban.DeleteAutomation(r.Context(), id); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
