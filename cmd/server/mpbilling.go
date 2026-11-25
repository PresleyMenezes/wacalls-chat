package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Cobrança mensal das empresas via Mercado Pago (assinatura recorrente por
// cartão — API /preapproval).
//
// Regras de atraso (a partir do dia em que o pagamento falhou/venceu):
//   - até 15 dias: tolerância, a empresa segue funcionando (status "overdue");
//   - de 16 a 30 dias: empresa suspensa (bloqueada), pode voltar ao pagar;
//   - depois de 30 dias: assinatura cancelada no Mercado Pago e empresa
//     bloqueada até uma nova assinatura.
// Empresas marcadas como "cortesia" nunca são cobradas nem bloqueadas.
//
// Variáveis de ambiente:
//   MP_ACCESS_TOKEN   token de produção (ou de teste) do Mercado Pago
//   PUBLIC_BASE_URL   (opcional) ex.: https://chat2.sendconnect.com.br
// ---------------------------------------------------------------------------

const (
	billingGraceDays  = 15
	billingCancelDays = 30
	mpAPI             = "https://api.mercadopago.com"
)

type billingPlan struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	MaxUsers   int    `json:"maxUsers"`
	PriceCents int    `json:"priceCents"`
	Active     bool   `json:"active"`
}

type companyBilling struct {
	CompanyID      string
	Courtesy       bool
	PlanID         string
	Status         string // none | pending | active | overdue | suspended | canceled
	MPID           string
	InitPoint      string
	NextDue        int64
	OverdueSince   int64
	BillingBlocked bool
}

func (s *server) ensureMPSchema(ctx context.Context) {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS billing_plans (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			max_users INTEGER NOT NULL DEFAULT 1,
			price_cents INTEGER NOT NULL DEFAULT 0,
			active INTEGER NOT NULL DEFAULT 1,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS company_billing (
			company_id TEXT PRIMARY KEY,
			courtesy INTEGER NOT NULL DEFAULT 0,
			plan_id TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'none',
			mp_id TEXT NOT NULL DEFAULT '',
			init_point TEXT NOT NULL DEFAULT '',
			next_due INTEGER NOT NULL DEFAULT 0,
			overdue_since INTEGER NOT NULL DEFAULT 0,
			billing_blocked INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0
		)`,
	} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			slog.Error("mp billing schema", "err", err)
		}
	}
	// Uma única vez: todas as empresas que já existem entram como cortesia.
	if v, _ := s.settings.getKV(ctx, "mp_billing_seeded"); v == "" {
		_, _ = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO company_billing (company_id, courtesy, status, updated_at)
			SELECT id, 1, 'none', ? FROM users WHERE COALESCE(parent_id,'') = ''`, time.Now().Unix())
		_ = s.settings.setKV(ctx, "mp_billing_seeded", "1")
	}
}

func (s *server) getBilling(ctx context.Context, companyID string) companyBilling {
	b := companyBilling{CompanyID: companyID, Status: "none"}
	var courtesy, blocked int
	err := s.db.QueryRowContext(ctx, `SELECT courtesy, plan_id, status, mp_id, init_point, next_due, overdue_since, billing_blocked
		FROM company_billing WHERE company_id = ?`, companyID).
		Scan(&courtesy, &b.PlanID, &b.Status, &b.MPID, &b.InitPoint, &b.NextDue, &b.OverdueSince, &blocked)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		slog.Warn("getBilling", "err", err)
	}
	b.Courtesy = courtesy == 1
	b.BillingBlocked = blocked == 1
	return b
}

func (s *server) saveBilling(ctx context.Context, b companyBilling) error {
	c, bl := 0, 0
	if b.Courtesy {
		c = 1
	}
	if b.BillingBlocked {
		bl = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO company_billing
		(company_id, courtesy, plan_id, status, mp_id, init_point, next_due, overdue_since, billing_blocked, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(company_id) DO UPDATE SET courtesy=excluded.courtesy, plan_id=excluded.plan_id,
			status=excluded.status, mp_id=excluded.mp_id, init_point=excluded.init_point,
			next_due=excluded.next_due, overdue_since=excluded.overdue_since,
			billing_blocked=excluded.billing_blocked, updated_at=excluded.updated_at`,
		b.CompanyID, c, b.PlanID, b.Status, b.MPID, b.InitPoint, b.NextDue, b.OverdueSince, bl, time.Now().Unix())
	return err
}

func (s *server) getPlan(ctx context.Context, id string) (billingPlan, bool) {
	var p billingPlan
	var active int
	err := s.db.QueryRowContext(ctx, `SELECT id, name, max_users, price_cents, active FROM billing_plans WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.MaxUsers, &p.PriceCents, &active)
	p.Active = active == 1
	return p, err == nil
}

// ---------- Mercado Pago HTTP ----------

func mpToken() string { return strings.TrimSpace(os.Getenv("MP_ACCESS_TOKEN")) }

func mpDo(ctx context.Context, method, path string, body any, out any) error {
	tok := mpToken()
	if tok == "" {
		return errors.New("MP_ACCESS_TOKEN não configurado no servidor")
	}
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, mpAPI+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	cl := &http.Client{Timeout: 20 * time.Second}
	res, err := cl.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		return fmt.Errorf("mercado pago %d: %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

type mpPreapproval struct {
	ID              string `json:"id"`
	Status          string `json:"status"`
	InitPoint       string `json:"init_point"`
	NextPaymentDate string `json:"next_payment_date"`
	ExternalRef     string `json:"external_reference"`
}

func publicBase(r *http.Request) string {
	if b := strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL")), "/"); b != "" {
		return b
	}
	proto := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		proto = "https"
	}
	return proto + "://" + r.Host
}

// ---------- Sincronização / regras ----------

// applyBlock bloqueia (ou libera) a empresa por motivo de cobrança.
func (s *server) setBillingBlock(ctx context.Context, b *companyBilling, block bool) {
	if block {
		_ = s.auth.SetActive(ctx, b.CompanyID, false)
		s.auth.revokeTenantTokens(ctx, b.CompanyID)
		b.BillingBlocked = true
		return
	}
	if b.BillingBlocked {
		_ = s.auth.SetActive(ctx, b.CompanyID, true)
		b.BillingBlocked = false
	}
}

// syncPreapproval lê a assinatura no Mercado Pago e atualiza o estado local.
func (s *server) syncPreapproval(ctx context.Context, companyID string) error {
	b := s.getBilling(ctx, companyID)
	if b.MPID == "" {
		return nil
	}
	var pa mpPreapproval
	if err := mpDo(ctx, http.MethodGet, "/preapproval/"+url.PathEscape(b.MPID), nil, &pa); err != nil {
		return err
	}
	if t, err := time.Parse(time.RFC3339, pa.NextPaymentDate); err == nil {
		b.NextDue = t.Unix()
	}
	switch pa.Status {
	case "authorized":
		if b.Status == "pending" {
			b.Status = "active"
		}
	case "paused":
		if b.OverdueSince == 0 {
			b.OverdueSince = time.Now().Unix()
		}
	case "cancelled":
		b.Status = "canceled"
	}
	return s.saveBilling(ctx, b)
}

// markPayment registra o resultado de uma cobrança (webhook).
func (s *server) markPayment(ctx context.Context, companyID string, paid bool) {
	b := s.getBilling(ctx, companyID)
	if b.Courtesy {
		return
	}
	if paid {
		b.OverdueSince = 0
		b.Status = "active"
		s.setBillingBlock(ctx, &b, false)
	} else if b.OverdueSince == 0 {
		b.OverdueSince = time.Now().Unix()
		b.Status = "overdue"
	}
	_ = s.saveBilling(ctx, b)
}

// enforceBilling aplica as regras de atraso a uma empresa.
func (s *server) enforceBilling(ctx context.Context, b companyBilling) {
	if b.Courtesy {
		if b.BillingBlocked {
			s.setBillingBlock(ctx, &b, false)
			_ = s.saveBilling(ctx, b)
		}
		return
	}
	now := time.Now().Unix()
	// Venceu e nenhum pagamento foi confirmado (dá 1 dia para o webhook chegar).
	if b.Status == "active" && b.NextDue > 0 && now > b.NextDue+86400 && b.OverdueSince == 0 {
		b.OverdueSince = b.NextDue
	}
	if b.OverdueSince == 0 {
		return
	}
	days := int((now - b.OverdueSince) / 86400)
	switch {
	case days > billingCancelDays:
		if b.Status != "canceled" {
			if b.MPID != "" {
				_ = mpDo(ctx, http.MethodPut, "/preapproval/"+url.PathEscape(b.MPID), map[string]string{"status": "cancelled"}, nil)
			}
			b.Status = "canceled"
		}
		s.setBillingBlock(ctx, &b, true)
	case days > billingGraceDays:
		b.Status = "suspended"
		s.setBillingBlock(ctx, &b, true)
	default:
		b.Status = "overdue"
	}
	_ = s.saveBilling(ctx, b)
}

func (s *server) billingLoop() {
	time.Sleep(30 * time.Second)
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		rows, err := s.db.QueryContext(ctx, `SELECT company_id FROM company_billing WHERE courtesy = 0`)
		var ids []string
		if err == nil {
			for rows.Next() {
				var id string
				if rows.Scan(&id) == nil {
					ids = append(ids, id)
				}
			}
			rows.Close()
		}
		for _, id := range ids {
			if mpToken() != "" {
				if err := s.syncPreapproval(ctx, id); err != nil {
					slog.Warn("mp sync", "company", id, "err", err)
				}
			}
			s.enforceBilling(ctx, s.getBilling(ctx, id))
		}
		cancel()
		<-tick.C
	}
}

// ---------- Handlers ----------

// POST /api/billing/mp/webhook (público; os dados são sempre reconsultados
// na API do Mercado Pago, então uma notificação falsa não tem efeito).
func (s *server) handleMPWebhook(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Type string `json:"type"`
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body)
	typ := body.Type
	if typ == "" {
		typ = r.URL.Query().Get("type")
	}
	if typ == "" {
		typ = r.URL.Query().Get("topic")
	}
	id := body.Data.ID
	if id == "" {
		id = r.URL.Query().Get("data.id")
	}
	if id == "" {
		id = r.URL.Query().Get("id")
	}
	w.WriteHeader(http.StatusOK)
	if id == "" || mpToken() == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		switch typ {
		case "subscription_preapproval", "preapproval":
			var pa mpPreapproval
			if err := mpDo(ctx, http.MethodGet, "/preapproval/"+url.PathEscape(id), nil, &pa); err != nil || pa.ExternalRef == "" {
				return
			}
			_ = s.syncPreapproval(ctx, pa.ExternalRef)
			s.enforceBilling(ctx, s.getBilling(ctx, pa.ExternalRef))
		case "subscription_authorized_payment", "authorized_payment":
			var ap struct {
				PreapprovalID string `json:"preapproval_id"`
				Status        string `json:"status"`
				Payment       struct {
					Status string `json:"status"`
				} `json:"payment"`
			}
			if err := mpDo(ctx, http.MethodGet, "/authorized_payments/"+url.PathEscape(id), nil, &ap); err != nil || ap.PreapprovalID == "" {
				return
			}
			var pa mpPreapproval
			if err := mpDo(ctx, http.MethodGet, "/preapproval/"+url.PathEscape(ap.PreapprovalID), nil, &pa); err != nil || pa.ExternalRef == "" {
				return
			}
			switch {
			case ap.Payment.Status == "approved":
				s.markPayment(ctx, pa.ExternalRef, true)
			case ap.Payment.Status == "rejected" || ap.Status == "recycling" || ap.Status == "cancelled":
				s.markPayment(ctx, pa.ExternalRef, false)
			}
			_ = s.syncPreapproval(ctx, pa.ExternalRef)
			s.enforceBilling(ctx, s.getBilling(ctx, pa.ExternalRef))
		}
	}()
}

// GET /api/admin/billing/plans
func (s *server) handlePlansList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT id, name, max_users, price_cents, active FROM billing_plans ORDER BY max_users ASC, price_cents ASC`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []billingPlan{}
	for rows.Next() {
		var p billingPlan
		var a int
		if rows.Scan(&p.ID, &p.Name, &p.MaxUsers, &p.PriceCents, &a) == nil {
			p.Active = a == 1
			out = append(out, p)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"plans": out, "mpConfigured": mpToken() != ""})
}

// POST /api/admin/billing/plans  {id?, name, maxUsers, priceCents, active}
func (s *server) handlePlanSave(w http.ResponseWriter, r *http.Request) {
	var p billingPlan
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" || p.MaxUsers < 1 || p.PriceCents < 100 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "informe nome, número de usuários (≥1) e preço (≥ R$ 1,00)"})
		return
	}
	a := 0
	if p.Active {
		a = 1
	}
	if p.ID == "" {
		p.ID = newID()
	}
	_, err := s.db.ExecContext(r.Context(), `INSERT INTO billing_plans (id, name, max_users, price_cents, active, created_at)
		VALUES (?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, max_users=excluded.max_users,
			price_cents=excluded.price_cents, active=excluded.active`,
		p.ID, p.Name, p.MaxUsers, p.PriceCents, a, time.Now().Unix())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// POST /api/admin/companies/{id}/courtesy {courtesy}
func (s *server) handleCompanyCourtesy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Courtesy bool `json:"courtesy"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if ok, err := s.auth.isTenantRoot(r.Context(), id); err != nil || !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "empresa não encontrada"})
		return
	}
	b := s.getBilling(r.Context(), id)
	b.Courtesy = body.Courtesy
	if body.Courtesy {
		b.OverdueSince = 0
		s.setBillingBlock(r.Context(), &b, false)
	}
	if err := s.saveBilling(r.Context(), b); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "courtesy": b.Courtesy})
}

// POST /api/admin/companies/{id}/subscribe {planId, payerEmail?}
// Cria a assinatura no Mercado Pago e devolve o link de pagamento.
func (s *server) handleCompanySubscribe(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		PlanID     string `json:"planId"`
		PayerEmail string `json:"payerEmail"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	root, err := s.auth.userByID(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "empresa não encontrada"})
		return
	}
	plan, ok := s.getPlan(r.Context(), body.PlanID)
	if !ok || !plan.Active {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "plano inválido ou inativo"})
		return
	}
	b := s.getBilling(r.Context(), id)
	if b.Courtesy {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empresa está como cortesia; desmarque a cortesia antes de cobrar"})
		return
	}
	payer := strings.TrimSpace(body.PayerEmail)
	if payer == "" {
		payer = root.Email
	}
	base := publicBase(r)
	// Cancela assinatura anterior ainda aberta, para não cobrar em duplicidade.
	if b.MPID != "" && b.Status != "canceled" {
		_ = mpDo(r.Context(), http.MethodPut, "/preapproval/"+url.PathEscape(b.MPID), map[string]string{"status": "cancelled"}, nil)
	}
	var pa mpPreapproval
	err = mpDo(r.Context(), http.MethodPost, "/preapproval", map[string]any{
		"reason":             fmt.Sprintf("%s - %s", plan.Name, root.CompanyName),
		"external_reference": id,
		"payer_email":        payer,
		"back_url":           base + "/",
		"notification_url":   base + "/api/billing/mp/webhook",
		"status":             "pending",
		"auto_recurring": map[string]any{
			"frequency":          1,
			"frequency_type":     "months",
			"transaction_amount": float64(plan.PriceCents) / 100.0,
			"currency_id":        "BRL",
		},
	}, &pa)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	b.PlanID = plan.ID
	b.MPID = pa.ID
	b.InitPoint = pa.InitPoint
	b.Status = "pending"
	b.OverdueSince = 0
	b.NextDue = 0
	if err := s.saveBilling(r.Context(), b); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"initPoint": pa.InitPoint})
}

// POST /api/admin/companies/{id}/cancel-subscription
func (s *server) handleCompanyCancelSub(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	b := s.getBilling(r.Context(), id)
	if b.MPID != "" {
		if err := mpDo(r.Context(), http.MethodPut, "/preapproval/"+url.PathEscape(b.MPID), map[string]string{"status": "cancelled"}, nil); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
	}
	b.Status = "canceled"
	b.InitPoint = ""
	b.OverdueSince = 0
	_ = s.saveBilling(r.Context(), b)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// planUserLimit devolve o máximo de usuários do plano da empresa (0 = sem limite).
func (s *server) planUserLimit(ctx context.Context, tenantID string) (int, string) {
	b := s.getBilling(ctx, tenantID)
	if b.Courtesy || b.PlanID == "" {
		return 0, ""
	}
	p, ok := s.getPlan(ctx, b.PlanID)
	if !ok {
		return 0, ""
	}
	return p.MaxUsers, p.Name
}

// GET /api/billing/mine — assinatura da própria empresa (só o dono).
func (s *server) handleBillingMine(w http.ResponseWriter, r *http.Request) {
	u := currentUserFromReq(r)
	if u == nil || u.ParentID != "" || !u.IsAdmin() || u.IsSuperAdmin() {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "somente o dono da empresa"})
		return
	}
	ctx := r.Context()
	b := s.getBilling(ctx, u.ID)
	if b.MPID != "" && mpToken() != "" && !b.Courtesy {
		sc, cancel := context.WithTimeout(ctx, 8*time.Second)
		_ = s.syncPreapproval(sc, u.ID)
		cancel()
		b = s.getBilling(ctx, u.ID)
	}
	out := map[string]any{
		"courtesy": b.Courtesy,
		"status":   b.Status,
		"nextDue":  b.NextDue,
	}
	if b.OverdueSince > 0 {
		days := int((time.Now().Unix() - b.OverdueSince) / 86400)
		out["overdueDays"] = days
		left := billingCancelDays - days
		if left < 0 {
			left = 0
		}
		out["daysUntilCancel"] = left
		gl := billingGraceDays - days
		if gl < 0 {
			gl = 0
		}
		out["graceDaysLeft"] = gl
	}
	if b.Status == "pending" || b.Status == "overdue" || b.Status == "suspended" {
		out["initPoint"] = b.InitPoint
	}
	if p, ok := s.getPlan(ctx, b.PlanID); ok {
		out["plan"] = p
	}
	if users, err := s.auth.ListUsersByTenant(ctx, u.ID); err == nil {
		n := 0
		for _, x := range users {
			if x.Active {
				n++
			}
		}
		out["usersCount"] = n
	}
	writeJSON(w, http.StatusOK, out)
}

var mpLoopOnce sync.Once

func (s *server) registerMPBillingRoutes(mux *http.ServeMux) {
	s.ensureMPSchema(context.Background())
	mux.HandleFunc("POST /api/billing/mp/webhook", s.handleMPWebhook)
	mux.HandleFunc("GET /api/billing/mine", s.requireAuth(s.handleBillingMine))
	mux.HandleFunc("GET /api/admin/billing/plans", s.requireSuperAdmin(s.handlePlansList))
	mux.HandleFunc("POST /api/admin/billing/plans", s.requireSuperAdmin(s.handlePlanSave))
	mux.HandleFunc("POST /api/admin/companies/{id}/courtesy", s.requireSuperAdmin(s.handleCompanyCourtesy))
	mux.HandleFunc("POST /api/admin/companies/{id}/subscribe", s.requireSuperAdmin(s.handleCompanySubscribe))
	mux.HandleFunc("POST /api/admin/companies/{id}/cancel-subscription", s.requireSuperAdmin(s.handleCompanyCancelSub))
	mpLoopOnce.Do(func() { go s.billingLoop() })
}
