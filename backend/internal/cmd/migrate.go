package cmd

import (
	"context"
	"fmt"
	"os"
	"strings"

	_ "github.com/gogf/gf/contrib/drivers/sqlite/v2"
	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gcmd"

	"cloud-conference-backend/internal/password"
)

var Migrate = gcmd.Command{
	Name:  "migrate",
	Usage: "migrate -script=<path>   |   migrate -query=<sql>",
	Brief: "在 SQLite 上跑一段 SQL 脚本 或 执行一条查询",
	Func: func(ctx context.Context, parser *gcmd.Parser) error {
		// 连接串只从 database.default.link 读：口令进命令行会被 shell history 与进程列表留下，
		// 而这份配置文件本来就是连接串的真源（见 AGENTS.md「凭据」节）。
		db := g.DB()

		if q := gcmd.GetOpt("query", "").String(); q != "" {
			return runQuery(ctx, db, q)
		}

		scriptPath := gcmd.GetOpt("script", "").String()
		if scriptPath == "" {
			return fmt.Errorf("必须提供 -script 或 -query")
		}
		return runScript(ctx, db, scriptPath)
	},
}

// DbInit 把首次部署要跑的三步收成一个命令：建库+字典/账号种子 → 灌测试账号口令 → 换成哈希。
// 收成一个命令有两个理由：① 少跑任何一步，现场的症状都是"页面能开但没人登得进去"；
// ② 拆开写进部署文档，会让人以为"灌口令"是一道需要他处理的凭据工序 —— 实际上种子已在镜像里。
var DbInit = gcmd.Command{
	Name:  "db-init",
	Usage: "db-init",
	Brief: "首次部署初始化：建库 + 灌入镜像内置的账号种子 + 把口令换成 PBKDF2 哈希（幂等，可重复跑）",
	Func: func(ctx context.Context, parser *gcmd.Parser) error {
		db := g.DB()
		for _, script := range []string{"manifest/sql/sqlite_create.sql", "manifest/sql/seed-credentials.sql"} {
			if err := runScript(ctx, db, script); err != nil {
				return err
			}
		}
		return hashStoredPasswords(ctx, db)
	},
}

// HashPasswords 单独一条命令，不塞进 -script 的参数里：口令哈希是"跑一次就够"的动作，
// 和建表脚本混在一起容易在重跑建库时被人漏掉。
var HashPasswords = gcmd.Command{
	Name:  "hash-passwords",
	Usage: "hash-passwords",
	Brief: "把 sys_user.PASSWORD 里遗留的明文口令批量换成 PBKDF2 哈希（幂等，可重复跑）",
	Func: func(ctx context.Context, parser *gcmd.Parser) error {
		return hashStoredPasswords(ctx, g.DB())
	},
}

// hashStoredPasswords 把 sys_user.PASSWORD 里遗留的明文一次性换成 PBKDF2 哈希。
//
// 幂等：带算法前缀的行跳过；空串行跳过 —— 空串是建库脚本的"还没配口令"占位，
// 哈希它等于给这一行开一个"空口令也能进"的后门。
// 只动本地口令这一列：THIRD_PARTY_PASSWORD 要原样发给三方换令牌，哈希过一次就废了。
func hashStoredPasswords(ctx context.Context, db gdb.DB) error {
	rows, err := db.Model("sys_user").Ctx(ctx).Fields("ID, USERNAME, PASSWORD").All()
	if err != nil {
		return fmt.Errorf("读 sys_user 失败: %w", err)
	}
	var upgraded, hashed, blank int
	for _, r := range rows {
		cur := r["PASSWORD"].String()
		if cur == "" {
			blank++
			continue
		}
		if password.Stored(cur) {
			hashed++
			continue
		}
		sum, err := password.Hash(cur)
		if err != nil {
			return fmt.Errorf("哈希失败 user=%d: %w", r["ID"].Int64(), err)
		}
		if _, err := db.Model("sys_user").Ctx(ctx).Where("ID", r["ID"].Int64()).
			Data(gdb.Map{"PASSWORD": sum}).Update(); err != nil {
			return fmt.Errorf("回写失败 user=%d: %w", r["ID"].Int64(), err)
		}
		upgraded++
	}
	fmt.Printf("口令哈希迁移：升级 %d 行，已是哈希 %d 行，空占位 %d 行\n", upgraded, hashed, blank)
	return nil
}

func runQuery(ctx context.Context, db gdb.DB, q string) error {
	list, err := db.GetAll(ctx, q)
	if err != nil {
		return fmt.Errorf("query 失败: %w", err)
	}
	if len(list) == 0 {
		fmt.Println("(0 rows)")
		return nil
	}
	cols := make([]string, 0, len(list[0]))
	for k := range list[0] {
		cols = append(cols, k)
	}
	fmt.Println(strings.Join(cols, "\t"))
	for _, row := range list {
		cells := make([]string, len(cols))
		for i, c := range cols {
			cells[i] = row[c].String()
		}
		fmt.Println(strings.Join(cells, "\t"))
	}
	fmt.Printf("(%d rows)\n", len(list))
	return nil
}

func runScript(ctx context.Context, db gdb.DB, scriptPath string) error {
	body, err := os.ReadFile(scriptPath)
	if err != nil {
		return fmt.Errorf("读脚本失败: %w", err)
	}
	stmts := splitStatements(string(body))
	var okCount, errCount int
	for i, stmt := range stmts {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		if _, err := db.Exec(ctx, stmt); err != nil {
			errCount++
			head := firstLine(stmt)
			fmt.Printf("[FAIL %03d] %v\n        SQL: %s\n", i, err, head)
		} else {
			okCount++
		}
	}
	fmt.Printf("\n%s: %d OK, %d FAIL, total %d stmts\n", scriptPath, okCount, errCount, okCount+errCount)
	if errCount > 0 {
		return fmt.Errorf("%d 条语句失败", errCount)
	}
	return nil
}

// splitStatements 按 ; 切分，跳过 -- 行注释和字符串里的分号。
// 达梦不像 MySQL 有 statement 批处理协议，只能一次一条 Exec。
func splitStatements(sql string) []string {
	var out []string
	var buf strings.Builder
	var inSQ, inDQ bool
	lines := strings.Split(sql, "\n")
	for _, ln := range lines {
		trimmed := strings.TrimSpace(ln)
		if !inSQ && !inDQ && strings.HasPrefix(trimmed, "--") {
			continue
		}
		for i := 0; i < len(ln); i++ {
			c := ln[i]
			switch c {
			case '\'':
				if !inDQ {
					inSQ = !inSQ
				}
			case '"':
				if !inSQ {
					inDQ = !inDQ
				}
			case ';':
				if !inSQ && !inDQ {
					out = append(out, buf.String())
					buf.Reset()
					continue
				}
			}
			buf.WriteByte(c)
		}
		buf.WriteByte('\n')
	}
	if rem := strings.TrimSpace(buf.String()); rem != "" {
		out = append(out, rem)
	}
	return out
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.IndexByte(s, '\n'); idx > 0 {
		return s[:idx] + " ..."
	}
	if len(s) > 200 {
		return s[:200] + " ..."
	}
	return s
}
