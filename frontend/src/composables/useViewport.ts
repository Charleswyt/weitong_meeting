import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'

/** 断点与布局档位：手机 ≤767 / 平板 768–1023 / 桌面 ≥1024。 */
export type ViewportTier = 'phone' | 'tablet' | 'desktop'

export const VIEWPORT_PHONE_MAX = 767
export const VIEWPORT_TABLET_MAX = 1023

function readTier(w: number): ViewportTier {
  if (w <= VIEWPORT_PHONE_MAX) return 'phone'
  if (w <= VIEWPORT_TABLET_MAX) return 'tablet'
  return 'desktop'
}

export interface ViewportApi {
  width: Ref<number>
  height: Ref<number>
  tier: Ref<ViewportTier>
  isPhone: ComputedRef<boolean>
  isTablet: ComputedRef<boolean>
  isDesktop: ComputedRef<boolean>
  /** 手机或平板：侧栏/会中控制要收一档信息。 */
  isCompact: ComputedRef<boolean>
}

/**
 * 视口档位。会中页用它决定「主控键 vs 更多」、布局强制宫格；
 * 外壳用它决定侧栏抽屉 / 底栏。
 */
export function useViewport(): ViewportApi {
  const width = ref(typeof window !== 'undefined' ? window.innerWidth : 1280)
  const height = ref(typeof window !== 'undefined' ? window.innerHeight : 800)
  const tier = ref<ViewportTier>(
    typeof window !== 'undefined' ? readTier(window.innerWidth) : 'desktop',
  )

  function sync() {
    width.value = window.innerWidth
    height.value = window.innerHeight
    tier.value = readTier(window.innerWidth)
    document.documentElement.dataset.vp = tier.value
  }

  onMounted(() => {
    sync()
    window.addEventListener('resize', sync, { passive: true })
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', sync)
  })

  return {
    width,
    height,
    tier,
    isPhone: computed(() => tier.value === 'phone'),
    isTablet: computed(() => tier.value === 'tablet'),
    isDesktop: computed(() => tier.value === 'desktop'),
    isCompact: computed(() => tier.value !== 'desktop'),
  }
}
