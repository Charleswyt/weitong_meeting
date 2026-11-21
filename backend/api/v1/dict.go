package v1

import "github.com/gogf/gf/v2/frame/g"

type DictListReq struct {
	g.Meta `path:"/dicts/{type}" method:"get" tags:"字典"`
	Type   string `json:"type" v:"required"`
}

type DictListRes struct {
	List []DictItemVo `json:"list"`
}

type DictItemVo struct {
	Value   string `json:"value"`
	Label   string `json:"label"`
	TagType string `json:"tagType,omitempty"`
	Sort    int    `json:"sort"`
}
