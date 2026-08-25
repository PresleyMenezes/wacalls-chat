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

// billingCache absorbs the subscription-status and free-tier-limits
// lookups used to gate every single outgoing chat message/call
// (enforceFreeTier, called from handleChatSend/handleStartCall BEFORE the
// actual WhatsApp send). Without this cache, a non-admin agent sending a
// message triggers ~5 synchronous SQLite round-trips (subscription row +
// three separate free-tier-limit settings + weekly usage count) before the
// message even reaches WhatsApp — under load this alone can add multi-
// second delays to sending, independent of anything client-side.
type billingCache struct {
	mu  sync.Mutex
	ttl time.Duration

	subs   map[string]cachedSubscription
	limits *cachedLimits
}

type cachedSubscription struct {
	row subscriptionRow
	err error
	at  time.Time
}

type cachedLimits struct {
	val freeTierLimits
	at  time.Time
}

func newBillingCache(ttl time.Duration) *billingCache {
	return &billingCache{ttl: ttl, subs: map[string]cachedSubscription{}}
}

func (c *billingCache) getSubscription(userID string, compute func() (subscriptionRow, error)) (subscriptionRow, error) {
	c.mu.Lock()
	if v, ok := c.subs[userID]; ok && time.Since(v.at) < c.ttl {
		c.mu.Unlock()
		return v.row, v.err
	}
	c.mu.Unlock()
	row, err := compute()
	c.mu.Lock()
	c.subs[userID] = cachedSubscription{row: row, err: err, at: time.Now()}
	c.mu.Unlock()
	return row, err
}

// invalidateSubscription drops the cached subscription for a user —
// called right after upsertSubscription (e.g. a Stripe webhook), so a
// plan change reflects immediately instead of waiting out the TTL.
func (c *billingCache) invalidateSubscription(userID string) {
	c.mu.Lock()
	delete(c.subs, userID)
	c.mu.Unlock()
}

// getLimits caches the free-tier limits (a small set of admin-configured
// platform-wide settings, not per-user) with a longer TTL — these change
// essentially never during normal operation.
func (c *billingCache) getLimits(compute func() freeTierLimits) freeTierLimits {
	c.mu.Lock()
	if c.limits != nil && time.Since(c.limits.at) < c.ttl*4 {
		v := c.limits.val
		c.mu.Unlock()
		return v
	}
	c.mu.Unlock()
	val := compute()
	c.mu.Lock()
	c.limits = &cachedLimits{val: val, at: time.Now()}
	c.mu.Unlock()
	return val
}
