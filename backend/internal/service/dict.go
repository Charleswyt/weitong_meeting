package service

import (
	"context"
	"fmt"
	"time"

	"github.com/gogf/gf/v2/os/gcache"

	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/model/entity"
)

// DictService 缓存 sys_dict_data 全表，按 dict_type 分组。
// 字典是几十行的近静态表，读多写少 —— 缓存是这里的性能答案，
// 不给 dict_type 补索引是本轮 DDL 的明确约定（见 create.sql 头部）。
type DictService struct {
	cache *gcache.Cache
}

func NewDictService() *DictService {
	return &DictService{cache: gcache.New()}
}

const dictCacheKey = "sys_dict_data:all"
const dictCacheTTL = 10 * time.Minute

// MapByType 返回 dict_value -> dict_label 的映射；缓存未命中时全表加载一次。
func (s *DictService) MapByType(ctx context.Context, dictType string) (map[string]string, error) {
	items, err := s.itemsByType(ctx, dictType)
	if err != nil {
		return nil, err
	}
	m := make(map[string]string, len(items))
	for _, it := range items {
		m[it.Value] = it.Label
	}
	return m, nil
}

// LabelOf 单个 code -> 中文；未命中返回空串（调用方自己决定回退策略）。
func (s *DictService) LabelOf(ctx context.Context, dictType, code string) string {
	if code == "" {
		return ""
	}
	m, err := s.MapByType(ctx, dictType)
	if err != nil {
		return ""
	}
	return m[code]
}

// ListByType 返回按 sort 排序的完整字典条目，用于前端下拉与状态色渲染。
func (s *DictService) ListByType(ctx context.Context, dictType string) ([]DictItemVo, error) {
	return s.itemsByType(ctx, dictType)
}

type DictItemVo struct {
	Value   string `json:"value"`
	Label   string `json:"label"`
	TagType string `json:"tagType,omitempty"`
	Sort    int    `json:"sort"`
}

func (s *DictService) itemsByType(ctx context.Context, dictType string) ([]DictItemVo, error) {
	cached, err := s.cache.GetOrSetFuncLock(ctx, dictCacheKey, func(ctx context.Context) (interface{}, error) {
		var rows []entity.SysDictData
		if err := dao.SysDictData.Ctx(ctx).OrderAsc("SORT").Scan(&rows); err != nil {
			return nil, fmt.Errorf("加载字典失败: %w", err)
		}
		grouped := make(map[string][]DictItemVo)
		for _, r := range rows {
			grouped[r.DictType] = append(grouped[r.DictType], DictItemVo{
				Value:   r.DictValue,
				Label:   r.DictLabel,
				TagType: r.TagType,
				Sort:    r.Sort,
			})
		}
		return grouped, nil
	}, dictCacheTTL)
	if err != nil {
		return nil, err
	}
	grouped, ok := cached.Val().(map[string][]DictItemVo)
	if !ok {
		return nil, nil
	}
	return grouped[dictType], nil
}

// ClearCache 在字典管理界面（未来若有）改数据后调用；本轮没有管理入口，只是预留。
func (s *DictService) ClearCache(ctx context.Context) {
	_, _ = s.cache.Remove(ctx, dictCacheKey)
}
