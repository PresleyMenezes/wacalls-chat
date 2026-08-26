package main

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type reportCounter struct {
	Total    int `json:"total"`
	Inbound  int `json:"inbound"`
	Outbound int `json:"outbound"`
}

type reportCalls struct {
	Total           int   `json:"total"`
	Inbound         int   `json:"inbound"`
	Outbound        int   `json:"outbound"`
	Answered        int   `json:"answered"`
	Missed          int   `json:"missed"`
	Video           int   `json:"video"`
	TotalDurationMs int64 `json:"totalDurationMs"`
	AvgDurationMs   int64 `json:"avgDurationMs"`
}

type reportTickets struct {
	Closed          int `json:"closed"`
	Waiting         int `json:"waiting"`
	Open            int `json:"open"`
	ClosedWithMsg   int `json:"closedWithMsg"`
	ClosedNoMsg     int `json:"closedNoMsg"`
	AvgResolutionMs int64 `json:"avgResolutionMs,omitempty"`
}

type reportDaily struct {
	Day            string `json:"day"`
	MessagesIn     int    `json:"messagesIn"`
	MessagesOut    int    `json:"messagesOut"`
	CallsIn        int    `json:"callsIn"`
	CallsOut       int    `json:"callsOut"`
	CallsAnswered  int    `json:"callsAnswered"`
	CallsMissed    int    `json:"callsMissed"`
	TicketsClosed  int    `json:"ticketsClosed"`
	RespondedChats int    `json:"respondedChats"`
	Opened         int    `json:"opened"`
}

type reportLabelCount struct {
	Label string `json:"label"`
	Count int    `json:"count"`
}

type reportAgentCount struct {
	UserID                string          `json:"userId"`
	Email                 string          `json:"email,omitempty"`
	Name                  string          `json:"name,omitempty"`
	Closed                int             `json:"closed"`
	MessagesSent          int             `json:"messagesSent"`
	RespondedChats        int             `json:"respondedChats"`
	FirstResponses        int             `json:"firstResponses"`
	AvgFirstResponseMs    int64           `json:"avgFirstResponseMs,omitempty"`
	AvgResolutionMs       int64           `json:"avgResolutionMs,omitempty"`
	totalFirstResponseMs  int64           `json:"-"`
	totalResolutionMs     int64           `json:"-"`
	resolvedCount         int             `json:"-"`
	respondedChatSet      map[string]bool `json:"-"`
}

type reportRatings struct {
	Total   int `json:"total"`
	Good    int `json:"good"`
	Bad     int `json:"bad"`
	Awful   int `json:"awful"`
	Average int `json:"average"`
}

type reportHourly struct {
	Hour           int `json:"hour"`
	MessagesOut    int `json:"messagesOut"`
	MessagesIn     int `json:"messagesIn"`
	ReceivedChats  int `json:"receivedChats"`
	RespondedChats int `json:"respondedChats"`
	Opened         int `json:"opened"`
	TicketsClosed  int `json:"ticketsClosed"`
}

type reportSummary struct {
	From                 int64              `json:"from"`
	To                   int64              `json:"to"`
	SessionID            string             `json:"sessionId,omitempty"`
	Messages             reportCounter      `json:"messages"`
	Calls                reportCalls        `json:"calls"`
	Tickets              reportTickets      `json:"tickets"`
	Daily                []reportDaily      `json:"daily"`
	Hourly               []reportHourly     `json:"hourly"`
	ClosureReasons       []reportLabelCount `json:"closureReasons"`
	Agents               []reportAgentCount `json:"agents"`
	Ratings              reportRatings      `json:"ratings"`
	AvgFirstResponseMs   int64              `json:"avgFirstResponseMs,omitempty"`
}

func (s *server) registerReportRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/reports/summary", s.requireAuth(s.handleReportSummary))
	mux.HandleFunc("GET /api/reports/hour-detail", s.requireAuth(s.handleReportHourDetail))
	mux.HandleFunc("GET /api/reports/card-detail", s.requireAuth(s.handleReportCardDetail))
}

// reportHourChat is one row in the drill-down list shown when the operator
// clicks an hour column in "Atendimentos por hora" — enough to render a
// clickable chat entry and to build the /chats?jid=&sid= deep link.
type reportHourChat struct {
	SessionID   string `json:"sessionId"`
	ChatJID     string `json:"chatJid"`
	Name        string `json:"name,omitempty"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
	LastMessage string `json:"lastMessage"`
	LastKind    string `json:"lastKind"`
	LastTs      int64  `json:"lastTs"`
	LastFromMe  bool   `json:"lastFromMe"`
}

func (s *server) handleReportHourDetail(w http.ResponseWriter, r *http.Request) {
	u := currentUserFromReq(r)
	q := r.URL.Query()
	now := time.Now().UnixMilli()
	from, _ := strconv.ParseInt(q.Get("from"), 10, 64)
	to, _ := strconv.ParseInt(q.Get("to"), 10, 64)
	if to == 0 {
		to = now
	}
	if from == 0 {
		from = to - int64(30*24*time.Hour/time.Millisecond)
	}
	hour, err := strconv.Atoi(q.Get("hour"))
	if err != nil || hour < 0 || hour > 23 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "hour must be 0-23"})
		return
	}
	requested := strings.TrimSpace(q.Get("sessionId"))
	agentFilter := strings.TrimSpace(q.Get("agentId"))
	visible := s.sessions.infosFor(u.ID, u.IsSuperAdmin())
	sessionIDs := make([]string, 0, len(visible))
	visibleSet := map[string]bool{}
	for _, si := range visible {
		visibleSet[si.ID] = true
		if requested == "" || si.ID == requested {
			sessionIDs = append(sessionIDs, si.ID)
		}
	}
	if requested != "" && !visibleSet[requested] {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such session"})
		return
	}

	out := []reportHourChat{}
	if s.messages != nil {
		for _, sid := range sessionIDs {
			chats, cerr := s.messages.ListChatsActiveInHour(r.Context(), sid, from, to, hour)
			if cerr != nil {
				continue
			}
			var metas map[string]ChatMeta
			if s.chatMeta != nil {
				metas, _ = s.chatMeta.ListBySession(r.Context(), sid)
			}
			for _, c := range chats {
				if agentFilter != "" {
					m, ok := metas[c.ChatJID]
					if !ok || m.AssignedUserID != agentFilter {
						continue
					}
				}
				row := reportHourChat{
					SessionID: sid, ChatJID: c.ChatJID,
					LastMessage: c.LastMessage, LastKind: c.LastKind,
					LastTs: c.LastTs, LastFromMe: c.LastFromMe,
				}
				if m, ok := metas[c.ChatJID]; ok {
					row.Name = m.Name
					row.AvatarURL = m.AvatarURL
				}
				out = append(out, row)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastTs > out[j].LastTs })
	writeJSON(w, http.StatusOK, map[string]any{"chats": out})
}

// handleReportCardDetail is the drill-down behind the KPI cards in
// "Atendimentos no chat": Finalizados, Com mensagem, Sem mensagem,
// Respondidas, Em aberto (sem resposta) e Aguardando. Each category reuses
// the exact same data source the aggregate count on the card comes from,
// so the list always matches the number the operator clicked on.
func (s *server) handleReportCardDetail(w http.ResponseWriter, r *http.Request) {
	u := currentUserFromReq(r)
	q := r.URL.Query()
	now := time.Now().UnixMilli()
	from, _ := strconv.ParseInt(q.Get("from"), 10, 64)
	to, _ := strconv.ParseInt(q.Get("to"), 10, 64)
	if to == 0 {
		to = now
	}
	if from == 0 {
		from = to - int64(30*24*time.Hour/time.Millisecond)
	}
	category := strings.TrimSpace(q.Get("category"))
	valid := map[string]bool{"closed": true, "closedWithMsg": true, "closedNoMsg": true, "responded": true, "openNoReply": true, "waiting": true}
	if !valid[category] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid category"})
		return
	}
	requested := strings.TrimSpace(q.Get("sessionId"))
	agentFilter := strings.TrimSpace(q.Get("agentId"))
	visible := s.sessions.infosFor(u.ID, u.IsSuperAdmin())
	sessionIDs := make([]string, 0, len(visible))
	visibleSet := map[string]bool{}
	for _, si := range visible {
		visibleSet[si.ID] = true
		if requested == "" || si.ID == requested {
			sessionIDs = append(sessionIDs, si.ID)
		}
	}
	if requested != "" && !visibleSet[requested] {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such session"})
		return
	}

	out := []reportHourChat{}
	for _, sid := range sessionIDs {
		var metas map[string]ChatMeta
		if s.chatMeta != nil {
			metas, _ = s.chatMeta.ListBySession(r.Context(), sid)
		}
		addRow := func(chatJID string, lastTs int64, fallbackName string) {
			row := reportHourChat{SessionID: sid, ChatJID: chatJID, LastTs: lastTs}
			if s.messages != nil {
				if body, kind, ts, fromMe, ok := s.messages.LastMessageFor(r.Context(), sid, chatJID, to); ok {
					row.LastMessage, row.LastKind, row.LastTs, row.LastFromMe = body, kind, ts, fromMe
				}
			}
			if m, ok := metas[chatJID]; ok {
				row.Name = m.Name
				row.AvatarURL = m.AvatarURL
			} else if fallbackName != "" {
				row.Name = fallbackName
			}
			out = append(out, row)
		}

		switch category {
		case "closed", "closedWithMsg", "closedNoMsg":
			if s.chatMeta == nil {
				continue
			}
			closures, cerr := s.chatMeta.listClosuresInRange(r.Context(), sid, from, to)
			if cerr != nil {
				continue
			}
			for _, c := range closures {
				if agentFilter != "" && c.UserID != agentFilter {
					continue
				}
				hasMsg := false
				if s.messages != nil {
					hasMsg, _ = s.messages.HasPriorOutbound(r.Context(), sid, c.ChatJID, c.ClosedAt+1)
				}
				if category == "closedWithMsg" && !hasMsg {
					continue
				}
				if category == "closedNoMsg" && hasMsg {
					continue
				}
				addRow(c.ChatJID, c.ClosedAt, "")
			}
		case "responded":
			if s.messages == nil {
				continue
			}
			chats, merr := s.messages.RespondedChatsInRange(r.Context(), sid, from, to, agentFilter)
			if merr != nil {
				continue
			}
			for _, c := range chats {
				addRow(c.ChatJID, c.LastTs, "")
			}
		case "openNoReply", "waiting":
			if metas == nil {
				continue
			}
			for jid, m := range metas {
				if category == "openNoReply" {
					if m.Status != ChatStatusOpen {
						continue
					}
					if agentFilter != "" && m.AssignedUserID != agentFilter {
						continue
					}
					if s.messages != nil {
						if had, _ := s.messages.HasPriorOutbound(r.Context(), sid, jid, to); had {
							continue
						}
					}
				} else {
					if m.Status == ChatStatusOpen || m.Status == ChatStatusClosed {
						continue
					}
				}
				addRow(jid, m.UpdatedAt, m.Name)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastTs > out[j].LastTs })
	writeJSON(w, http.StatusOK, map[string]any{"chats": out})
}

func (s *server) handleReportSummary(w http.ResponseWriter, r *http.Request) {
	u := currentUserFromReq(r)
	q := r.URL.Query()
	now := time.Now().UnixMilli()
	from, _ := strconv.ParseInt(q.Get("from"), 10, 64)
	to, _ := strconv.ParseInt(q.Get("to"), 10, 64)
	if to == 0 {
		to = now
	}
	if from == 0 {
		from = to - int64(30*24*time.Hour/time.Millisecond)
	}
	requested := strings.TrimSpace(q.Get("sessionId"))
	agentFilter := strings.TrimSpace(q.Get("agentId"))
	visible := s.sessions.infosFor(u.ID, u.IsSuperAdmin())
	sessionIDs := make([]string, 0, len(visible))
	visibleSet := map[string]bool{}
	for _, si := range visible {
		visibleSet[si.ID] = true
		if requested == "" || si.ID == requested {
			sessionIDs = append(sessionIDs, si.ID)
		}
	}
	if requested != "" && !visibleSet[requested] {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such session"})
		return
	}

	summary := reportSummary{From: from, To: to, SessionID: requested}
	daily := makeDailyBuckets(from, to)
	hourly := makeHourlyBuckets()
	reasonCounts := map[string]int{}
	agents := map[string]*reportAgentCount{}
	// Quando duas conexões cadastradas participam do mesmo grupo, a mesma
	// mensagem de grupo pode ser registrada em ambas as sessões — uma com
	// a atribuição correta do agente, outra "espectadora" sem atribuição
	// (a conexão só viu o eco da mensagem circulando no grupo, sem saber
	// quem digitou). Pré-carregamos a melhor atribuição conhecida por ID de
	// mensagem, e mais adiante contamos cada ID de mensagem no máximo uma
	// vez, para não inflar os totais nem perder a atribuição do agente.
	bestSentByUserID := map[string]string{}
	if s.messages != nil {
		for _, sid := range sessionIDs {
			rows, err := s.messages.listForReport(r.Context(), sid, from, to)
			if err != nil {
				continue
			}
			for _, m := range rows {
				if m.FromMe && m.SentByUserID != "" {
					if _, ok := bestSentByUserID[m.ID]; !ok {
						bestSentByUserID[m.ID] = m.SentByUserID
					}
				}
			}
		}
	}
	countedMsgIDs := map[string]bool{}
	var totalResolutionMs int64
	var totalResolutions int
	for _, sid := range sessionIDs {
		// Pré-carrega a atribuição atual de cada conversa uma única vez por
		// sessão, reaproveitada para filtrar mensagens/tickets por agente
		// sem disparar uma consulta por mensagem.
		var metasForAgent map[string]ChatMeta
		if agentFilter != "" && s.chatMeta != nil {
			metasForAgent, _ = s.chatMeta.ListBySession(r.Context(), sid)
		}
		if s.messages != nil {
			rows, err := s.messages.listForReport(r.Context(), sid, from, to)
			if err == nil {
				// Rastreia, por conversa, se há uma mensagem recebida aguardando
				// a primeira resposta de um agente. As linhas já vêm ordenadas
				// por ts ASC (listForReport), então basta percorrer em sequência.
				awaitingSince := map[string]int64{}
				for _, m := range rows {
					// Mensagens de grupo entram nos contadores desta seção do
					// mesmo jeito que conversas de contato — grupos seguem o
					// mesmo fluxo Aguardando → Atendendo → Finalizado (mesma
					// decisão já aplicada aos fechamentos "com/sem mensagem").
					// Deduplica mensagens de saída vistas por mais de uma conexão
					// cadastrada no mesmo grupo (ver comentário acima) — cada ID
					// de mensagem só é contado uma vez nos totais.
					effectiveSentByUserID := m.SentByUserID
					if m.FromMe {
						if best, ok := bestSentByUserID[m.ID]; ok {
							effectiveSentByUserID = best
						}
						if countedMsgIDs[m.ID] {
							continue
						}
						countedMsgIDs[m.ID] = true
					}
					// Com filtro de agente ativo: mensagens enviadas contam se
					// foram digitadas por ele; mensagens recebidas contam se a
					// conversa está (ou estava) atribuída a ele. Sem filtro,
					// tudo é contado normalmente (comportamento geral).
					countsForAgent := true
					if agentFilter != "" {
						if m.FromMe {
							countsForAgent = effectiveSentByUserID == agentFilter
						} else {
							countsForAgent = metasForAgent[m.ChatJID].AssignedUserID == agentFilter
						}
					}
					if countsForAgent {
						summary.Messages.Total++
					}
					b := daily[reportDayKey(m.Ts)]
					hb := hourly[reportHourKey(m.Ts)]
					if m.FromMe {
						if countsForAgent {
							summary.Messages.Outbound++
							if b != nil {
								b.MessagesOut++
							}
							if hb != nil {
								hb.MessagesOut++
							}
						}
						if effectiveSentByUserID != "" {
						a := agents[effectiveSentByUserID]
						if a == nil {
							a = &reportAgentCount{UserID: effectiveSentByUserID, respondedChatSet: map[string]bool{}}
							agents[effectiveSentByUserID] = a
						}
						if a.respondedChatSet == nil {
							a.respondedChatSet = map[string]bool{}
						}
						a.MessagesSent++
						if !a.respondedChatSet[m.ChatJID] {
							a.respondedChatSet[m.ChatJID] = true
							a.RespondedChats++
							if b != nil && countsForAgent {
								b.RespondedChats++
							}
							if hb != nil && countsForAgent {
								hb.RespondedChats++
							}
						}
						if waitStart, ok := awaitingSince[m.ChatJID]; ok {
							a.FirstResponses++
							a.totalFirstResponseMs += m.Ts - waitStart
							delete(awaitingSince, m.ChatJID)
						}
					}
					} else {
						if countsForAgent {
							summary.Messages.Inbound++
							if b != nil {
								b.MessagesIn++
							}
							if hb != nil {
								hb.MessagesIn++
							}
						}
						if _, ok := awaitingSince[m.ChatJID]; !ok {
							awaitingSince[m.ChatJID] = m.Ts
							// "Conversas recebidas": primeira mensagem recebida desta
							// conversa dentro do período — uma por chat, no dia/hora
							// em que ela chegou.
							if countsForAgent && hb != nil {
								hb.ReceivedChats++
							}
						}
					}
				}
			}
		}

		if s.calls != nil {
			calls, err := s.calls.ListBetween(r.Context(), sid, from, to)
			if err == nil {
				for _, c := range calls {
					if agentFilter != "" && c.OwnerUser != agentFilter {
						continue
					}
					summary.Calls.Total++
					b := daily[reportDayKey(c.StartedAt)]
					if strings.EqualFold(c.Direction, "outbound") {
						summary.Calls.Outbound++
						if b != nil {
							b.CallsOut++
						}
					} else {
						summary.Calls.Inbound++
						if b != nil {
							b.CallsIn++
						}
					}
					if c.Answered {
						summary.Calls.Answered++
						summary.Calls.TotalDurationMs += c.DurationMs
						if b != nil {
							b.CallsAnswered++
						}
					} else if !strings.EqualFold(c.Direction, "outbound") {
						summary.Calls.Missed++
						if b != nil {
							b.CallsMissed++
						}
					}
					if c.Video {
						summary.Calls.Video++
					}
				}
			}
		}

		if s.chatMeta != nil {
			metas, err := s.chatMeta.ListBySession(r.Context(), sid)
			if err == nil {
				for _, m := range metas {
					if agentFilter != "" {
						// "Em aberto" só faz sentido por agente quando a conversa
						// está atribuída a ele. "Aguardando" nunca tem dono (por
						// definição), então não é filtrado — mesma lógica já
						// aplicada às chamadas perdidas.
						if m.Status == ChatStatusOpen && m.AssignedUserID != agentFilter {
							continue
						}
						if m.Status != ChatStatusOpen && m.Status != ChatStatusClosed {
							continue
						}
					}
					switch m.Status {
					case ChatStatusClosed:
						summary.Tickets.Closed++
					case ChatStatusOpen:
						summary.Tickets.Open++
					default:
						summary.Tickets.Waiting++
					}
				}
			}

			var createdTs map[string]int64
			closures, err := s.chatMeta.listClosuresInRange(r.Context(), sid, from, to)
			if err == nil {
				if len(closures) > 0 {
					createdTs, _ = s.chatMeta.createdTimestampsBySession(r.Context(), sid)
				}
				for _, c := range closures {
					if agentFilter != "" && c.UserID != agentFilter {
						continue
					}
					label := strings.TrimSpace(c.Reason)
					if label == "" {
						label = "Sem descrição"
					}
					reasonCounts[label]++
					key := c.UserID
					if key == "" {
						key = c.UserEmail
					}
					if key == "" {
						key = "Sistema"
					}
					a := agents[key]
					if a == nil {
						a = &reportAgentCount{UserID: c.UserID, Email: c.UserEmail}
						if a.UserID == "" {
							a.UserID = key
						}
						agents[key] = a
					}
					a.Closed++
					if b := daily[reportDayKey(c.ClosedAt)]; b != nil {
						b.TicketsClosed++
					}
					if hb := hourly[reportHourKey(c.ClosedAt)]; hb != nil {
						hb.TicketsClosed++
					}
					// Distingue conversas encerradas em que o agente chegou a
					// responder de vez daquelas fechadas sem nenhuma mensagem
					// enviada (ex.: spam, engano, fechamento em lote). Contamos
					// a partir dos EVENTOS de fechamento no período (não do
					// status atual) para não perder fechamentos de conversas
					// que foram reabertas depois — por isso o total exibido
					// ("Finalizados") também deriva dessa mesma contagem.
					if s.messages != nil {
						if hasMsg, herr := s.messages.HasPriorOutbound(r.Context(), sid, c.ChatJID, c.ClosedAt+1); herr == nil {
							if hasMsg {
								summary.Tickets.ClosedWithMsg++
							} else {
								summary.Tickets.ClosedNoMsg++
							}
						}
					}
					// Tempo médio de finalização: do momento em que a conversa foi
					// criada (primeira vez que o chat apareceu) até este
					// fechamento. Aproximação — em conversas reabertas várias
					// vezes, mede desde a criação original, não desde a última
					// reabertura.
					if createdAt, ok := createdTs[c.ChatJID]; ok && c.ClosedAt > createdAt {
						dur := c.ClosedAt - createdAt
						totalResolutionMs += dur
						totalResolutions++
						a.totalResolutionMs += dur
						a.resolvedCount++
					}
				}
			}

			// "Abertas por dia": quantas conversas o(s) agente(s) começaram a
			// atender (clicaram em "Atender") em cada dia do período — usado
			// pelo gráfico de barras, com o mesmo recorte de agente já
			// aplicado ao restante da seção.
			opened, oerr := s.chatMeta.listOpenedEventsInRange(r.Context(), sid, from, to)
			if oerr == nil {
				for _, e := range opened {
					if agentFilter != "" && e.UserID != agentFilter {
						continue
					}
					if b := daily[reportDayKey(e.Ts)]; b != nil {
						b.Opened++
					}
					if hb := hourly[reportHourKey(e.Ts)]; hb != nil {
						hb.Opened++
					}
				}
			}
		}
	}

	if summary.Calls.Answered > 0 {
		summary.Calls.AvgDurationMs = summary.Calls.TotalDurationMs / int64(summary.Calls.Answered)
	}
	summary.Daily = flattenDaily(daily)
	for label, count := range reasonCounts {
		summary.ClosureReasons = append(summary.ClosureReasons, reportLabelCount{Label: label, Count: count})
	}
	sort.Slice(summary.ClosureReasons, func(i, j int) bool { return summary.ClosureReasons[i].Count > summary.ClosureReasons[j].Count })

	// Resolve e-mail e nome dos agentes que só apareceram via mensagens (sem
	// passar por closures, portanto ainda sem Email/Name preenchido).
	// Restrito ao próprio tenant — nunca busca usuários de outras empresas.
	emailByID := map[string]string{}
	nameByID := map[string]string{}
	if s.auth != nil {
		if users, uerr := s.auth.ListUsersByTenant(r.Context(), u.TenantID()); uerr == nil {
			for _, u := range users {
				emailByID[u.ID] = u.Email
				name := strings.TrimSpace(u.Name)
				if name == "" {
					name = strings.TrimSpace(u.CompanyName)
				}
				if name == "" && u.Email != "" {
					name = strings.Split(u.Email, "@")[0]
				}
				nameByID[u.ID] = name
			}
		}
	}
	var totalFirstResponseMs int64
	var totalFirstResponses int
	for _, a := range agents {
		if a.Email == "" {
			a.Email = emailByID[a.UserID]
		}
		if a.Name == "" {
			a.Name = nameByID[a.UserID]
		}
		if a.FirstResponses > 0 {
			a.AvgFirstResponseMs = a.totalFirstResponseMs / int64(a.FirstResponses)
			totalFirstResponseMs += a.totalFirstResponseMs
			totalFirstResponses += a.FirstResponses
		}
		if a.resolvedCount > 0 {
			a.AvgResolutionMs = a.totalResolutionMs / int64(a.resolvedCount)
		}
		summary.Agents = append(summary.Agents, *a)
	}
	if totalFirstResponses > 0 {
		summary.AvgFirstResponseMs = totalFirstResponseMs / int64(totalFirstResponses)
	}
	// O card "Finalizados" exibido reflete os fechamentos ocorridos NO
	// PERÍODO (mesma base dos sub-totais com/sem mensagem), não o status
	// atual das conversas — evitando o número de cima divergir da soma dos
	// dois valores pequenos abaixo dele.
	summary.Tickets.Closed = summary.Tickets.ClosedWithMsg + summary.Tickets.ClosedNoMsg
	if totalResolutions > 0 {
		summary.Tickets.AvgResolutionMs = totalResolutionMs / int64(totalResolutions)
	}
	sort.Slice(summary.Agents, func(i, j int) bool { return summary.Agents[i].Closed > summary.Agents[j].Closed })
	for _, h := range hourly {
		summary.Hourly = append(summary.Hourly, *h)
	}
	writeJSON(w, http.StatusOK, summary)
}

// brTZ is a fixed UTC-3 offset (Brasília time, no DST currently observed)
// used to bucket reports by day/hour the way a Brazilian user actually
// perceives them — timestamps are stored in UTC, so grouping by raw UTC
// hour/day shifts everything by 3h from what's shown on screen.
var brTZ = time.FixedZone("BRT", -3*60*60)

func reportDayKey(ts int64) string {
	return time.UnixMilli(ts).In(brTZ).Format("2006-01-02")
}

// reportHourKey buckets a timestamp into a 0-23 hour-of-day slot (Brasília
// time), ignoring the specific date — used for the "Atendimentos por hora"
// chart, which aggregates activity patterns across the whole period into
// 24 columns.
func reportHourKey(ts int64) int {
	return time.UnixMilli(ts).In(brTZ).Hour()
}

func makeHourlyBuckets() []*reportHourly {
	out := make([]*reportHourly, 24)
	for h := 0; h < 24; h++ {
		out[h] = &reportHourly{Hour: h}
	}
	return out
}

func makeDailyBuckets(from, to int64) map[string]*reportDaily {
	out := map[string]*reportDaily{}
	start := time.UnixMilli(from).In(brTZ)
	start = time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, brTZ)
	end := time.UnixMilli(to).In(brTZ)
	end = time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, brTZ)
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		out[key] = &reportDaily{Day: key}
	}
	return out
}

func flattenDaily(m map[string]*reportDaily) []reportDaily {
	out := make([]reportDaily, 0, len(m))
	for _, d := range m {
		out = append(out, *d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Day < out[j].Day })
	return out
}
