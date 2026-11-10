package main

import (
	"context"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Limpeza automática de mídia antiga de conversas.
//
// Todo dia às 03:30 (horário do servidor) apaga os arquivos de media/in
// (recebidos) e media/out (enviados) mais antigos que o prazo configurado, para
// o disco não encher. NÃO mexe em avatares, gravações de chamada, arquivos de
// fluxos nem no cache de voz: só nessas duas pastas de anexos de conversa.
//
// Configuração (variável de ambiente, opcional):
//   WACALLS_MEDIA_RETENTION_DAYS  dias a manter (padrão 30; mínimo 7; 0 desliga)

const (
	defaultMediaRetentionDays = 30
	minMediaRetentionDays     = 7
	mediaCleanupHour          = 3
	mediaCleanupMinute        = 30
)

func mediaRetentionDays() int {
	raw := strings.TrimSpace(os.Getenv("WACALLS_MEDIA_RETENTION_DAYS"))
	if raw == "" {
		return defaultMediaRetentionDays
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return defaultMediaRetentionDays
	}
	if n > 0 && n < minMediaRetentionDays {
		return minMediaRetentionDays // piso de segurança
	}
	return n
}

// cleanupOldMedia apaga arquivos comuns mais antigos que maxAge, somente dentro
// de media/in e media/out. Devolve quantos arquivos apagou e quantos bytes liberou.
func cleanupOldMedia(log *slog.Logger, maxAge time.Duration) (deleted int, freed int64) {
	cutoff := time.Now().Add(-maxAge)
	for _, sub := range []string{"in", "out"} {
		root := filepath.Join("media", sub)
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // pasta ausente ou ilegível: segue em frente
			}
			if d.IsDir() || !d.Type().IsRegular() {
				return nil // só arquivos comuns (ignora pastas e links)
			}
			info, ierr := d.Info()
			if ierr != nil || !info.ModTime().Before(cutoff) {
				return nil
			}
			if rerr := os.Remove(path); rerr != nil {
				log.Warn("media cleanup: não foi possível apagar", "path", path, "err", rerr)
				return nil
			}
			deleted++
			freed += info.Size()
			return nil
		})
	}
	return deleted, freed
}

// startMediaCleanup agenda a limpeza diária em segundo plano.
func startMediaCleanup(ctx context.Context, log *slog.Logger) {
	days := mediaRetentionDays()
	if days == 0 {
		log.Info("media cleanup: desativada (WACALLS_MEDIA_RETENTION_DAYS=0)")
		return
	}
	maxAge := time.Duration(days) * 24 * time.Hour
	log.Info("media cleanup: ativada", "retentionDays", days, "dailyAt", "03:30")
	go func() {
		for {
			now := time.Now()
			next := time.Date(now.Year(), now.Month(), now.Day(), mediaCleanupHour, mediaCleanupMinute, 0, 0, now.Location())
			if !next.After(now) {
				next = next.AddDate(0, 0, 1)
			}
			timer := time.NewTimer(time.Until(next))
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			deleted, freed := cleanupOldMedia(log, maxAge)
			log.Info("media cleanup: concluída", "deleted", deleted, "freedMB", freed/(1024*1024))
		}
	}()
}
