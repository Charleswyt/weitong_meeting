package main

import (
	"context"
	"os"

	_ "github.com/gogf/gf/contrib/drivers/sqlite/v2"
	"github.com/gogf/gf/v2/os/gcmd"

	"cloud-conference-backend/internal/cmd"
)

// 子命令直跑表：这些命令不进 HTTP 服务，跑完就退出，给容器初始化用。
// 加一条命令只改这张表，不要再往 main 里堆 if。
var subcommands = map[string]*gcmd.Command{
	"migrate":        &cmd.Migrate,
	"hash-passwords": &cmd.HashPasswords,
	"db-init":        &cmd.DbInit,
}

func main() {
	if len(os.Args) > 1 {
		if sc, ok := subcommands[os.Args[1]]; ok {
			if err := sc.Func(context.Background(), nil); err != nil {
				println(os.Args[1]+" failed:", err.Error())
				os.Exit(1)
			}
			return
		}
	}
	cmd.Main.Func(context.Background(), nil)
}

