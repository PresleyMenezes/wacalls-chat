package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// ---------------------------------------------------------------------------
// Painel do super admin: Empresas (clientes do SaaS).
//
// Uma "empresa" é a raiz de um tenant (usuário sem parent_id). Desativar a
// empresa bloqueia o login e as requisições de TODOS os usuários dela (ver
// accountBlocked, usada em Login e UserByToken). Apagar exige a senha do
// super admin e remove todos os dados da empresa.
// ---------------------------------------------------------------------------

type companyRow struct {
	ID            string `json:"id"`
	Email         string `json:"email"`
	CompanyName   string `json:"companyName"`
	Active        bool   `json:"active"`
	CreatedAt     int64  `json:"createdAt"`
	UsersCount    int    `json:"usersCount"`
	SessionsCount int    `json:"sessionsCount"`
	// Cobrança (Mercado Pago)
	Courtesy      bool   `json:"courtesy"`
	PlanName      string `json:"planName"`
	BillingStatus string `json:"billingStatus"`
	NextDue       int64  `json:"nextDue"`
	OverdueDays   int    `json:"overdueDays"`
	InitPoint     string `json:"initPoint"`
}

// accountBlocked informa se o usuário (ou a empresa dele) está desativado.
func (s *authStore) accountBlocked(ctx context.Context, userID string) bool {
	var own int
	var parent sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT u.active, p.active
		FROM users u LEFT JOIN users p ON p.id = u.parent_id AND u.parent_id != ''
		WHERE u.id = ?`, userID).Scan(&own, &parent)
	if err != nil {
		return false
	}
	if own != 1 {
		return true
	}
	return parent.Valid && parent.Int64 != 1
}

// CheckPassword confere a senha de um usuário sem alterar nada.
func (s *authStore) CheckPassword(ctx context.Context, userID, password string) error {
	var hash string
	if err := s.db.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&hash); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUserNotFound
		}
		return err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return ErrInvalidLogin
	}
	return nil
}

// tenantUserIDs devolve o id da empresa e de todos os usuários dela.
func (s *authStore) tenantUserIDs(ctx context.Context, rootID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM users WHERE id = ? OR parent_id = ?`, rootID, rootID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// revokeTenantTokens encerra as sessões de login de toda a empresa e avisa
// os navegadores abertos (SSE) para saírem na hora.
func (s *authStore) revokeTenantTokens(ctx context.Context, rootID string) {
	var toks []string
	rows, err := s.db.QueryContext(ctx, `
		SELECT t.token FROM auth_tokens t
		JOIN users u ON u.id = t.user_id
		WHERE u.id = ? OR u.parent_id = ?`, rootID, rootID)
	if err == nil {
		for rows.Next() {
			var t string
			if rows.Scan(&t) == nil {
				toks = append(toks, t)
			}
		}
		rows.Close()
	}
	_, _ = s.db.ExecContext(ctx, `DELETE FROM auth_tokens WHERE user_id IN (SELECT id FROM users WHERE id = ? OR parent_id = ?)`, rootID, rootID)
	if len(toks) > 0 && s.OnTokensRevoked != nil {
		go s.OnTokensRevoked(toks)
	}
}

// isTenantRoot confirma que o id existe e é uma empresa (sem parent_id).
func (s *authStore) isTenantRoot(ctx context.Context, id string) (bool, error) {
	var pid string
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(parent_id,'') FROM users WHERE id = ?`, id).Scan(&pid)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return pid == "", nil
}

func (s *server) isSuperAdminTenant(ctx context.Context, id string) bool {
	u, err := s.auth.userByID(ctx, id)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Email, SuperAdminEmail)
}

func (s *authStore) userByID(ctx context.Context, id string) (UserRow, error) {
	var u UserRow
	var active int
	err := s.db.QueryRowContext(ctx, `SELECT id, email, company_name, active, created_at FROM users WHERE id = ?`, id).
		Scan(&u.ID, &u.Email, &u.CompanyName, &active, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return UserRow{}, ErrUserNotFound
	}
	u.Active = active == 1
	return u, err
}

// GET /api/admin/companies
func (s *server) handleCompaniesOverview(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT r.id, r.email, r.company_name, r.active, r.created_at,
			(SELECT COUNT(1) FROM users c WHERE c.parent_id = r.id) + 1,
			(SELECT COUNT(1) FROM sessions x WHERE x.owner_id = r.id
				OR x.owner_id IN (SELECT id FROM users WHERE parent_id = r.id))
		FROM users r
		WHERE COALESCE(r.parent_id,'') = '' AND LOWER(r.email) != LOWER(?)
		ORDER BY r.created_at DESC`, SuperAdminEmail)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []companyRow{}
	for rows.Next() {
		var c companyRow
		var active int
		if err := rows.Scan(&c.ID, &c.Email, &c.CompanyName, &active, &c.CreatedAt, &c.UsersCount, &c.SessionsCount); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		c.Active = active == 1
		out = append(out, c)
	}
	rows.Close()
	now := time.Now().Unix()
	for i := range out {
		b := s.getBilling(r.Context(), out[i].ID)
		out[i].Courtesy = b.Courtesy
		out[i].BillingStatus = b.Status
		out[i].NextDue = b.NextDue
		out[i].InitPoint = b.InitPoint
		if b.OverdueSince > 0 {
			out[i].OverdueDays = int((now - b.OverdueSince) / 86400)
		}
		if b.PlanID != "" {
			if p, ok := s.getPlan(r.Context(), b.PlanID); ok {
				out[i].PlanName = p.Name
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"companies": out})
}

// POST /api/admin/companies  {companyName, email, password}
func (s *server) handleCompanyCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CompanyName string `json:"companyName"`
		Email       string `json:"email"`
		Password    string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if strings.TrimSpace(body.CompanyName) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "informe o nome da empresa"})
		return
	}
	u, err := s.auth.AdminCreateUser(r.Context(), body.Email, body.Password, body.CompanyName, "", RoleAdmin, "")
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, ErrEmailTaken) {
			code = http.StatusConflict
		}
		writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, companyRow{
		ID: u.ID, Email: u.Email, CompanyName: u.CompanyName, Active: true,
		CreatedAt: u.CreatedAt, UsersCount: 1,
	})
}

// POST /api/admin/companies/{id}/active  {active}
func (s *server) handleCompanySetActive(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Active bool `json:"active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	ok, err := s.auth.isTenantRoot(r.Context(), id)
	if err != nil || !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "empresa não encontrada"})
		return
	}
	if s.isSuperAdminTenant(r.Context(), id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a conta do super admin não pode ser desativada"})
		return
	}
	if err := s.auth.SetActive(r.Context(), id, body.Active); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !body.Active {
		s.auth.revokeTenantTokens(r.Context(), id)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "active": body.Active})
}

// POST /api/admin/companies/{id}/delete  {password}
// Exige a senha do super admin logado. Remove a empresa e tudo dela.
func (s *server) handleCompanyDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	me := currentUserFromReq(r)
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if strings.TrimSpace(body.Password) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "digite sua senha para apagar"})
		return
	}
	if err := s.auth.CheckPassword(r.Context(), me.ID, body.Password); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "senha incorreta"})
		return
	}
	ok, err := s.auth.isTenantRoot(r.Context(), id)
	if err != nil || !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "empresa não encontrada"})
		return
	}
	if id == me.ID || s.isSuperAdminTenant(r.Context(), id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a conta do super admin não pode ser apagada"})
		return
	}
	if err := s.purgeCompany(r.Context(), id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// purgeCompany apaga conexões do WhatsApp, equipes, quadros, mensagens e os
// usuários da empresa. Tabelas auxiliares são limpas em modo "melhor esforço".
func (s *server) purgeCompany(ctx context.Context, rootID string) error {
	// 1) Derruba os logins primeiro.
	s.auth.revokeTenantTokens(ctx, rootID)

	userIDs, err := s.auth.tenantUserIDs(ctx, rootID)
	if err != nil {
		return err
	}
	if len(userIDs) == 0 {
		return nil
	}
	inUsers := `(SELECT id FROM users WHERE id = ? OR parent_id = ?)`
	uargs := []any{rootID, rootID}
	exec := func(q string, args ...any) { _, _ = s.db.ExecContext(ctx, q, args...) }

	// 2) Conexões do WhatsApp (desloga o aparelho e remove do gerenciador).
	var sessionIDs []string
	if rows, err := s.db.QueryContext(ctx, `SELECT id FROM sessions WHERE owner_id IN `+inUsers, uargs...); err == nil {
		for rows.Next() {
			var sid string
			if rows.Scan(&sid) == nil {
				sessionIDs = append(sessionIDs, sid)
			}
		}
		rows.Close()
	}
	for _, sid := range sessionIDs {
		if s.sessions != nil {
			if err := s.sessions.Delete(ctx, sid); err != nil {
				exec(`DELETE FROM sessions WHERE id = ?`, sid)
			}
		} else {
			exec(`DELETE FROM sessions WHERE id = ?`, sid)
		}
		for _, q := range []string{
			`DELETE FROM messages WHERE session_id = ?`,
			`DELETE FROM chats WHERE session_id = ?`,
			`DELETE FROM chat_closures WHERE session_id = ?`,
			`DELETE FROM chat_events WHERE session_id = ?`,
			`DELETE FROM chat_rating_pending WHERE session_id = ?`,
			`DELETE FROM chat_ratings WHERE session_id = ?`,
			`DELETE FROM synced_contacts WHERE session_id = ?`,
			`DELETE FROM call_records WHERE session_id = ?`,
			`DELETE FROM flow_runs WHERE session_id = ?`,
			`DELETE FROM contact_tags WHERE session_id = ?`,
			`DELETE FROM kanban_cards WHERE session_id = ?`,
		} {
			exec(q, sid)
		}
	}

	// 3) Kanban (quadros da empresa), equipes e vínculos.
	exec(`DELETE FROM kanban_cards WHERE board_id IN (SELECT id FROM kanban_boards WHERE owner_id = ?)`, rootID)
	exec(`DELETE FROM kanban_columns WHERE board_id IN (SELECT id FROM kanban_boards WHERE owner_id = ?)`, rootID)
	exec(`DELETE FROM kanban_automations WHERE board_id IN (SELECT id FROM kanban_boards WHERE owner_id = ?)`, rootID)
	exec(`DELETE FROM kanban_boards WHERE owner_id = ?`, rootID)
	exec(`DELETE FROM kanban_team_seeded WHERE queue_id IN (SELECT id FROM queues WHERE owner_id = ?)`, rootID)
	exec(`DELETE FROM queues WHERE owner_id = ?`, rootID)

	// 4) Conteúdo por dono: fluxos, tags, respostas rápidas, assinatura.
	exec(`DELETE FROM flows WHERE owner_id IN `+inUsers, uargs...)
	exec(`DELETE FROM tags WHERE owner_id IN `+inUsers, uargs...)
	exec(`DELETE FROM quick_replies WHERE owner_id IN `+inUsers, uargs...)
	exec(`DELETE FROM billing_subscriptions WHERE user_id IN `+inUsers, uargs...)
	exec(`DELETE FROM company_billing WHERE company_id = ?`, rootID)

	// 5) Usuários e tabelas de vínculo.
	for _, q := range []string{
		`DELETE FROM user_queues WHERE user_id IN ` + inUsers,
		`DELETE FROM user_permissions WHERE user_id IN ` + inUsers,
		`DELETE FROM user_sessions_link WHERE user_id IN ` + inUsers,
		`DELETE FROM user_roles WHERE user_id IN ` + inUsers,
		`DELETE FROM auth_tokens WHERE user_id IN ` + inUsers,
	} {
		exec(q, uargs...)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE parent_id = ?`, rootID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, rootID); err != nil {
		return err
	}
	return nil
}

func (s *server) registerCompanyAdminRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/companies", s.requireSuperAdmin(s.handleCompaniesOverview))
	mux.HandleFunc("POST /api/admin/companies", s.requireSuperAdmin(s.handleCompanyCreate))
	mux.HandleFunc("POST /api/admin/companies/{id}/active", s.requireSuperAdmin(s.handleCompanySetActive))
	mux.HandleFunc("POST /api/admin/companies/{id}/delete", s.requireSuperAdmin(s.handleCompanyDelete))
}
