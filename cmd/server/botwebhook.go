package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func (s *server) registerBotWebhookRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/sessions/{sid}/bot-webhook/token", s.requireAuth(s.handleBotWebhookRegenToken))
	mux.HandleFunc("POST /api/sessions/{sid}/bot/send", s.handleBotWebhookSend)
}

type webhookInboundPayload struct {
	Connection  string `json:"connection"`
	SessionID   string `json:"sessionId"`
	ChatJID     string `json:"chatJid"`
	IsGroup     bool   `json:"isGroup"`
	ContactName string `json:"contactName,omitempty"`
	MessageID   string `json:"messageId"`
	Kind        string `json:"kind"`
	Body        string `json:"body"`
	Timestamp   int64  `json:"timestamp"`
}

func (s *Session) dispatchInboundWebhook(row MessageRow) {
	s.mu.Lock()
	url := strings.TrimSpace(s.webhookInboundURL)
	name := s.name
	s.mu.Unlock()
	if url == "" {
		return
	}
	payload := webhookInboundPayload{
		Connection:  name,
		SessionID:   row.SessionID,
		ChatJID:     row.ChatJID,
		IsGroup:     isGroupChatJID(row.ChatJID),
		ContactName: row.SenderName,
		MessageID:   row.ID,
		Kind:        row.Kind,
		Body:        row.Body,
		Timestamp:   row.Ts,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		s.log.Warn("bot webhook: build request failed", "err", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		s.log.Warn("bot webhook: dispatch failed", "url", url, "err", err)
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode >= 300 {
		s.log.Warn("bot webhook: non-2xx response", "url", url, "status", resp.StatusCode)
	}
}

func (s *server) handleBotWebhookRegenToken(w http.ResponseWriter, r *http.Request) {
	sess := s.sessionByID(w, r, r.PathValue("sid"))
	if sess == nil {
		return
	}
	tok, err := s.sessStore.regenerateWebhookToken(r.Context(), sess.id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	sess.mu.Lock()
	sess.webhookToken = tok
	sess.mu.Unlock()
	s.broker.emitSessionList(s.sessions.infos())
	writeJSON(w, http.StatusOK, map[string]string{"token": tok})
}

type webhookSendRequest struct {
	To        string `json:"to"`
	Text      string `json:"text"`
	ReplyToID string `json:"replyToId"`
	MediaURL  string `json:"mediaUrl"`
	MediaKind string `json:"mediaKind"`
	Caption   string `json:"caption"`
	FileName  string `json:"fileName"`
}

func (s *server) handleBotWebhookSend(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	sess, ok := s.sessions.Get(sid)
	if !ok || sess == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "connection not found"})
		return
	}
	sess.mu.Lock()
	wantToken := sess.webhookToken
	sess.mu.Unlock()
	if wantToken == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "webhook not configured for this connection"})
		return
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if got == "" {
		got = r.Header.Get("X-Webhook-Token")
	}
	if got != wantToken {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid token"})
		return
	}
	if sess.client == nil || sess.client.Store == nil || sess.client.Store.ID == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "not paired"})
		return
	}
	var body webhookSendRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 5<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	jid, err := parseChatJID(strings.TrimSpace(body.To))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	var quotedID string
	var ctxInfo *waE2E.ContextInfo
	if body.ReplyToID != "" {
		if original, ok, gerr := s.messages.Get(ctx, sess.id, body.ReplyToID); gerr == nil && ok {
			participant := original.SenderJID
			if original.FromMe || participant == "" {
				participant = jidOrEmpty(sess)
			}
			quotedID = original.ID
			ctxInfo = &waE2E.ContextInfo{
				StanzaID:      proto.String(original.ID),
				Participant:   proto.String(participant),
				QuotedMessage: &waE2E.Message{Conversation: proto.String(original.Body)},
			}
		}
	}

	if strings.TrimSpace(body.MediaURL) != "" {
		s.sendBotWebhookMedia(ctx, w, sess, jid, body, ctxInfo, quotedID)
		return
	}

	text := strings.TrimSpace(body.Text)
	if text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text or mediaUrl required"})
		return
	}
	var msg *waE2E.Message
	if ctxInfo != nil {
		msg = &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(text), ContextInfo: ctxInfo}}
	} else {
		msg = &waE2E.Message{Conversation: proto.String(text)}
	}
	resp, err := sess.client.SendMessage(ctx, jid, msg)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	row := MessageRow{
		ID: resp.ID, SessionID: sess.id, ChatJID: jid.String(),
		SenderJID: jidOrEmpty(sess), FromMe: true,
		Ts: resp.Timestamp.UnixMilli(), Kind: "text", Body: text,
		QuotedID:     quotedID,
		SentByUserID: externalDeviceAgentID,
	}
	if row.Ts == 0 {
		row.Ts = time.Now().UnixMilli()
	}
	_ = s.messages.Insert(ctx, row)
	s.markChatOpen(ctx, sess, row.ChatJID, nil)
	s.broker.emitMessage(row)
	writeJSON(w, http.StatusOK, map[string]any{"message": row})
}

func applyContextInfoToMediaMessage(msg *waE2E.Message, ctxInfo *waE2E.ContextInfo) {
	switch {
	case msg.GetImageMessage() != nil:
		msg.ImageMessage.ContextInfo = ctxInfo
	case msg.GetVideoMessage() != nil:
		msg.VideoMessage.ContextInfo = ctxInfo
	case msg.GetAudioMessage() != nil:
		msg.AudioMessage.ContextInfo = ctxInfo
	case msg.GetDocumentMessage() != nil:
		msg.DocumentMessage.ContextInfo = ctxInfo
	}
}

func (s *server) sendBotWebhookMedia(ctx context.Context, w http.ResponseWriter, sess *Session, jid types.JID, body webhookSendRequest, ctxInfo *waE2E.ContextInfo, quotedID string) {
	kind := strings.ToLower(strings.TrimSpace(body.MediaKind))
	if kind != "image" && kind != "video" && kind != "audio" && kind != "document" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mediaKind must be image, video, audio or document"})
		return
	}
	dlCtx, dlCancel := context.WithTimeout(ctx, 30*time.Second)
	defer dlCancel()
	dlReq, err := http.NewRequestWithContext(dlCtx, http.MethodGet, body.MediaURL, nil)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid mediaUrl"})
		return
	}
	dlResp, err := (&http.Client{Timeout: 30 * time.Second}).Do(dlReq)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": fmt.Sprintf("download mediaUrl: %v", err)})
		return
	}
	defer dlResp.Body.Close()
	if dlResp.StatusCode >= 300 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": fmt.Sprintf("mediaUrl returned status %d", dlResp.StatusCode)})
		return
	}
	data, err := io.ReadAll(io.LimitReader(dlResp.Body, 64<<20))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed reading mediaUrl body"})
		return
	}
	mime := dlResp.Header.Get("Content-Type")
	if mime == "" {
		mime = guessMimeForKind(kind)
	}

	var appInfo whatsmeow.MediaType
	switch kind {
	case "audio":
		appInfo = whatsmeow.MediaAudio
	case "video":
		appInfo = whatsmeow.MediaVideo
	case "document":
		appInfo = whatsmeow.MediaDocument
	default:
		appInfo = whatsmeow.MediaImage
	}
	upCtx, upCancel := context.WithTimeout(ctx, 60*time.Second)
	up, uerr := sess.client.Upload(upCtx, data, appInfo)
	upCancel()
	if uerr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("upload: %v", uerr)})
		return
	}
	msg := buildMediaMessage(kind, up, mime, body.Caption, body.FileName, uint64(len(data)))
	if ctxInfo != nil {
		applyContextInfoToMediaMessage(msg, ctxInfo)
	}
	sendCtx, sendCancel := context.WithTimeout(ctx, 20*time.Second)
	defer sendCancel()
	sresp, serr := sess.client.SendMessage(sendCtx, jid, msg)
	if serr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": serr.Error()})
		return
	}
	localURL := saveLocalMedia(sresp.ID, body.FileName, data)
	row := MessageRow{
		ID: sresp.ID, SessionID: sess.id, ChatJID: jid.String(),
		SenderJID: jidOrEmpty(sess), FromMe: true,
		Ts: sresp.Timestamp.UnixMilli(), Kind: kind, Body: body.Caption,
		MediaMime: mime, MediaURL: localURL, FileName: body.FileName, FileSize: int64(len(data)),
		QuotedID:     quotedID,
		SentByUserID: externalDeviceAgentID,
	}
	if row.Ts == 0 {
		row.Ts = time.Now().UnixMilli()
	}
	_ = s.messages.Insert(ctx, row)
	s.markChatOpen(ctx, sess, row.ChatJID, nil)
	s.broker.emitMessage(row)
	writeJSON(w, http.StatusOK, map[string]any{"message": row})
}
