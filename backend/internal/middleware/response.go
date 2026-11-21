package middleware

import "github.com/gogf/gf/v2/net/ghttp"

func ResponseHandler(r *ghttp.Request) {
	r.Middleware.Next()
}
