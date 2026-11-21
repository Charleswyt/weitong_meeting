/// <reference types="vite/client" />

/**
 * 构建期注入的值。
 *
 * 只允许放**源码里推不出来**的事实（打包时间），别把版本号塞进来 ——
 * 版本号的唯一来源是 `src/data/changelog.ts` 第一条，多一处就必然漂。
 */
interface ImportMetaEnv {
  /** 镜像构建时注入的打包时间；本地 `pnpm dev` / `pnpm build` 下为空 → 界面显示"开发态" */
  readonly VITE_BUILD_DATE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
