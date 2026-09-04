package main

import (
	"context"
	"net/http"
	"time"
)

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
