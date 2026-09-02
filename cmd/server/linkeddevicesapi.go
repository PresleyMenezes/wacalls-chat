package main

import (
	"context"
	"net/http"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// registerLinkedDevicesRoutes mounts the endpoint used by the "Buscar
// dispositivos vinculados" button in the connection editor — lets the
// operator pick the external bot's device number from a real list instead
// of guessing or digging through logs.
func (s *server) registerLinkedDevicesRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/sessions/{sid}/linked-devices", s.requireAuth(s.handleLinkedDevices))
}

type linkedDevicesResponse struct {
	OwnDevice int   `json:"ownDevice"`
	Devices   []int `json:"devices"`
}

func (s *server) handleLinkedDevices(w http.ResponseWriter, r *http.Request) {
	sess := s.sessionByID(w, r, r.PathValue("sid"))
	if sess == nil {
		return
	}
	if sess.client == nil || sess.client.Store == nil || sess.client.Store.ID == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "connection not paired"})
		return
	}
	ownJID := sess.client.Store.ID.ToNonAD()
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	// GetUserDevicesContext queries WhatsApp live for every AD (device)
	// JID linked to this account — WhatsApp Web sessions, companion
	// phones, and external tools like GOWA/n8n all show up here, since
	// they're all "just another linked device" from WhatsApp's point of
	// view. It never includes our own device.
	list, err := sess.client.GetUserDevicesContext(ctx, []types.JID{ownJID})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	out := linkedDevicesResponse{OwnDevice: int(sess.client.Store.ID.Device)}
	seen := map[int]bool{}
	for _, jid := range list {
		d := int(jid.Device)
		if d == out.OwnDevice || seen[d] {
			continue
		}
		seen[d] = true
		out.Devices = append(out.Devices, d)
	}
	writeJSON(w, http.StatusOK, out)
}
