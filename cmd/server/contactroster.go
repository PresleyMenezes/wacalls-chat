package main

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// Limita a sincronização AUTOMÁTICA (ao conectar) a uma vez a cada 6h por
// conexão. Ela consulta todos os grupos no WhatsApp; fazer isso a cada
// reconexão (a cada 20-50 min, e em cada reinício) é pesado e parece robô.
var (
	rosterSyncMu   sync.Mutex
	rosterSyncLast = map[string]time.Time{}
)

func shouldAutoSyncRoster(sessionID string) bool {
	rosterSyncMu.Lock()
	defer rosterSyncMu.Unlock()
	if t, ok := rosterSyncLast[sessionID]; ok && time.Since(t) < 6*time.Hour {
		return false
	}
	rosterSyncLast[sessionID] = time.Now()
	return true
}

// registerContactSyncRoutes mounts the manual "Sincronizar contatos e
// grupos agora" button endpoint.
func (s *server) registerContactSyncRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/sessions/{sid}/contacts/sync", s.requireAuth(s.handleContactsSync))
}

// syncContactsAndGroups pulls the connection's full WhatsApp roster
// (contacts + joined groups) and replaces our cached copy — this is what
// lets an agent call or message someone who has never sent a message into
// this system yet, instead of only ever seeing people after they write
// first. Reads from whatsmeow's own local store (already synced by
// WhatsApp itself after pairing), so this is fast and doesn't hit the
// network beyond what whatsmeow already keeps current.
func (s *Session) syncContactsAndGroups(ctx context.Context) (int, error) {
	if s.client == nil || s.client.Store == nil || s.client.Store.ID == nil {
		return 0, nil
	}
	var out []SyncedContactRow

	contacts, err := s.client.Store.Contacts.GetAllContacts(ctx)
	if err == nil {
		for jid, ci := range contacts {
			var name string
			switch {
			case ci.FullName != "":
				name = ci.FullName
			case ci.PushName != "":
				name = ci.PushName
			case ci.BusinessName != "":
				name = ci.BusinessName
			case ci.FirstName != "":
				name = ci.FirstName
			}
			if name == "" {
				continue
			}
			out = append(out, SyncedContactRow{ChatJID: jid.String(), Name: name, IsGroup: false})
		}
	} else {
		s.log.Warn("contact sync: GetAllContacts failed", "err", err)
	}

	groups, gerr := s.client.GetJoinedGroups(ctx)
	if gerr == nil {
		for _, g := range groups {
			if g == nil || g.Name == "" {
				continue
			}
			out = append(out, SyncedContactRow{ChatJID: g.JID.String(), Name: g.Name, IsGroup: true})
			// Também sincroniza os MEMBROS de cada grupo, com o nome
			// resolvido (mesma lógica usada em "Ver membros do grupo") —
			// sem isso, alguém que nunca mandou mensagem direto pra você
			// só aparecia com o @lid cru, sem nome nenhum.
			// GetJoinedGroups já traz os participantes de cada grupo: não é
			// preciso consultar grupo por grupo (eram dezenas de chamadas
			// extras ao WhatsApp a cada conexão).
			for _, p := range g.Participants {
				name := p.DisplayName
				if name == "" && s.client.Store.Contacts != nil {
					if ci, cerr := s.client.Store.Contacts.GetContact(ctx, p.JID.ToNonAD()); cerr == nil && ci.Found {
						switch {
						case ci.FullName != "":
							name = ci.FullName
						case ci.PushName != "":
							name = ci.PushName
						case ci.BusinessName != "":
							name = ci.BusinessName
						}
					}
				}
				if name == "" {
					continue
				}
				out = append(out, SyncedContactRow{ChatJID: p.JID.String(), Name: name, IsGroup: false})
			}
		}
	} else {
		s.log.Warn("contact sync: GetJoinedGroups failed", "err", gerr)
	}

	if s.mgr == nil || s.mgr.syncedContacts == nil {
		return len(out), nil
	}
	if err := s.mgr.syncedContacts.ReplaceAll(ctx, s.id, out); err != nil {
		return 0, err
	}
	return len(out), nil
}

func (s *server) handleContactsSync(w http.ResponseWriter, r *http.Request) {
	sess := s.sessionByID(w, r, r.PathValue("sid"))
	if sess == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	n, err := sess.syncContactsAndGroups(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"synced": n})
}
