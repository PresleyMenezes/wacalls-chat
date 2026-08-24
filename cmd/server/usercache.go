package main

import (
	"sync"
	"time"
)

// userScopeCache holds short-lived, per-user results for the tenant/role/
// session-link lookups used to decide who can see a real-time event
// (SessionManager.infosFor, called from Broker.deliverScoped on every
// message/call/status event). Without this cache, a single incoming or
// outgoing message can trigger several synchronous SQLite queries PER
// connected agent — under load, SQLite's single-writer lock turns that
// into multi-second delays for message send/receive. These values change
// rarely (an admin is promoted, a connection gets linked/unlinked), so a
// short TTL is enough to absorb bursts of chat activity without ever
// serving meaningfully stale data.
type userScopeCache struct {
	mu  sync.Mutex
	ttl time.Duration

	tenant   map[string]cachedString
	isAdmin  map[string]cachedBool
	sessions map[string]cachedStrings
}

type cachedString struct {
	val string
	at  time.Time
}

type cachedBool struct {
	val bool
	at  time.Time
}

type cachedStrings struct {
	val []string
	at  time.Time
}

func newUserScopeCache(ttl time.Duration) *userScopeCache {
	return &userScopeCache{
		ttl:      ttl,
		tenant:   map[string]cachedString{},
		isAdmin:  map[string]cachedBool{},
		sessions: map[string]cachedStrings{},
	}
}

func (c *userScopeCache) getTenant(userID string, compute func() string) string {
	c.mu.Lock()
	if v, ok := c.tenant[userID]; ok && time.Since(v.at) < c.ttl {
		c.mu.Unlock()
		return v.val
	}
	c.mu.Unlock()
	val := compute()
	c.mu.Lock()
	c.tenant[userID] = cachedString{val: val, at: time.Now()}
	c.mu.Unlock()
	return val
}

func (c *userScopeCache) getIsAdmin(userID string, compute func() bool) bool {
	c.mu.Lock()
	if v, ok := c.isAdmin[userID]; ok && time.Since(v.at) < c.ttl {
		c.mu.Unlock()
		return v.val
	}
	c.mu.Unlock()
	val := compute()
	c.mu.Lock()
	c.isAdmin[userID] = cachedBool{val: val, at: time.Now()}
	c.mu.Unlock()
	return val
}

func (c *userScopeCache) getSessions(userID string, compute func() []string) []string {
	c.mu.Lock()
	if v, ok := c.sessions[userID]; ok && time.Since(v.at) < c.ttl {
		c.mu.Unlock()
		return v.val
	}
	c.mu.Unlock()
	val := compute()
	c.mu.Lock()
	c.sessions[userID] = cachedStrings{val: val, at: time.Now()}
	c.mu.Unlock()
	return val
}

// invalidate drops every cached entry for a user — called after an action
// that can change tenant/role/session-link data (role change, session
// link/unlink), so the next event delivery reflects it immediately instead
// of waiting out the TTL.
func (c *userScopeCache) invalidate(userID string) {
	c.mu.Lock()
	delete(c.tenant, userID)
	delete(c.isAdmin, userID)
	delete(c.sessions, userID)
	c.mu.Unlock()
}
