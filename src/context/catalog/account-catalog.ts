/**
 * 账号池的模型目录与标识归一.
 *
 * 从 app-context.js 按职责切出. 这一层只读上游目录(CatalogHolder)与内置静态表,
 * 不碰冷却/会话/网络: 它的唯一职责是把三种模型标识(目录 key / 上游 legacy id /
 * 可读显示名)互相归一.
 *
 * 模型标识的唯一真源在这里, 上层(proxy / web)一律复用它, 不得另写映射.
 */
import { freebuffLegacyModelDigest } from '../../upstream/catalog-protocol.ts'
import { FREEBUFF_AVAILABLE_MODELS } from '../../model.ts'
import { publicModelId } from '../../util/public-id.ts'

/**
 * 在所有已知 runtime 的目录持有者上依次尝试解析, 返回第一个非空结果.
 *
 * 目录表要双向用(key → 显示名 / key → 可读 id / 显示名 → key), 集中在一处遍历.
 * 单个 runtime 抛错不影响其它账号(多账号池里目录是逐账号持有的).
 * @param {any} this 账号池(runtimes)
 * @param {(catalog: any) => string | null | undefined} fn
 * @returns {string | null}
 */
export function _fromCatalogs(this: any, fn: any) {
  for (const rt of this.byKey.values()) {
    try {
      const v = fn(rt?.upstream?.catalog)
      if (v) return v
    } catch {
      // 单个 runtime 取不到就换下一个
    }
  }
  return null
}

/**
 * 目录 key / 上游 legacy id / 可读名 → 人类可读显示名.
 *
 * 这是展示侧的公开入口(web 层要显示模型名时用它, 不要自己遍历
 * runtime 的 catalog).
 *
 * 上游回执侧(session.model / rateLimitsByModel / prices)用的全是目录 key,
 * 而会话清单(desktopPurchases[].model)用的是上游 legacy id,
 * 两种形式都要能显示成人能认的名字 ---- 所以内部先做归一(keyForName
 * 已支持三种形式),再查 displayName.
 *
 * 取不到就返回 null(调用方回落原值).
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @returns {string | null}
 */
export function displayNameFor(this: any, key: any) {
  if (typeof key !== 'string' || !key) return null
  return this._modelDisplayName(this.resolveModelAlias(key))
}

/**
 * 目录 key(m-00032eaeec)→ 人类可读显示名(MiMo 2.6 Flash).
 *
 * 上游回执侧(session.model / rateLimitsByModel / prices)用的全是目录 key,
 * 控制台要显示人能认的名字.目录行自带 displayName,抓目录时就缓存在
 * CatalogHolder.displayNames 里;取不到就返回 null(调用方回落原 key).
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @returns {string | null}
 */
export function _modelDisplayName(this: any, key: any) {
  if (typeof key !== 'string' || !key) return null
  const fromCatalog = this._fromCatalogs((cat: any) => cat?.displayNameForKey?.(key))
  if (fromCatalog) return fromCatalog
  // 兜底:实时目录未抓取时(服务刚启动,或该 runtime 的 catalog 尚未 fetch),
  // displayNameForKey 一律返回 null, 总览的额度列/模型列会渲染成裸目录 key.
  //
  // 兜底手法与 _modelCatalogId 一致:用目录 key 的 legacyDigest 反查内置
  // 静态表,命中则取其 displayName.不做模糊匹配.
  const digest = this._fromCatalogs((cat: any) => cat?.digestForKey?.(key))
  if (digest) {
    for (const m of FREEBUFF_AVAILABLE_MODELS) {
      if (m?.id && freebuffLegacyModelDigest(m.id) === digest && m.displayName) {
        return m.displayName
      }
    }
  }
  return null
}

/**
 * 目录 key(m-00032eaeec)→ 人类可读目录 id(deepseek/deepseek-v4-flash).
 *
 * 上游目录只列 key 与 legacy 摘要,不列可读 id;所以先用摘要命中目录行,
 * 再拿摘要去内置 catalog 反查.查不到返回 null ---- 上游新模型(内置目录尚未
 * 收录)本来就只有 key,调用方自行回落.
 * @param {any} this 账号池(runtimes)
 * @param {string} key
 * @returns {string | null}
 */
export function _modelCatalogId(this: any, key: any) {
  if (typeof key !== 'string' || !key) return null
  const digest = this._fromCatalogs((cat: any) => cat?.digestForKey?.(key))
  if (!digest) return null
  for (const m of FREEBUFF_AVAILABLE_MODELS) {
    if (m?.id && freebuffLegacyModelDigest(m.id) === digest) return m.id
  }
  return null
}

/**
 * 人类可读显示名(MiMo 2.6 Flash)→ 目录 key(m-00032eaeec).
 *
 * 下游 Agent 手里只有 /v1/models 的 id 与 display_name,照着 display_name
 * 填 model 是很自然的用法;而上游只认 key/句柄.这里把显示名落回 key,
 * 再走既有的 handleFor 映射.查不到返回 null(不改变原值).
 * @param {any} this 账号池(runtimes)
 * @param {string} name
 * @returns {string | null}
 */
export function _modelKeyForName(this: any, name: any) {
  if (typeof name !== 'string' || !name) return null
  return this._fromCatalogs((cat: any) => cat?.keyForName?.(name))
}

/**
 * 把一组上游模型标识(目录 key)补全成[对外展示三件套]:
 * { key, displayName, catalogId }.
 *
 * /v1/models 与 /api/models/upstream 都要这三样:key 是服务端寻址真值,
 * displayName 给人看,catalogId 是人类可读的请求口径.三者一起下发,
 * 下游照着任何一个填 model 都能被解析回去(见 proxy.js 的 chat 入口解析).
 * publicId 是对外模型 id(无空白):下游照着清单原样填回来时必须能解析,
 * 规则与构造同源见 util/public-id.ts.
 *
 * @param {any} this 账号池(runtimes)
 * @param {string[]} keys
 * @returns {{ key: string, displayName: string | null, catalogId: string | null,
 *   publicId: string }[]}
 */
export function modelAliases(this: any, keys: any) {
  const out = []
  for (const key of keys || []) {
    if (typeof key !== 'string' || !key) continue
    const displayName = this._modelDisplayName(key)
    const catalogId = this._modelCatalogId(key)
    out.push({
      key,
      displayName,
      catalogId,
      publicId: publicModelId({ catalogId, displayName, key }),
    })
  }
  return out
}

/**
 * 把客户端给的 model 值归一到调度口径.
 *
 * /v1/models 现在对外给的是可读 id(catalogId 或 displayName),所以下游
 * 有三条合法写法都可能到这儿:
 *
 *   - 目录 key(m-096e75164d)---- 老客户端/我们自己下发的 freebuff_key,原样保留;
 *   - 人类可读 id(deepseek/deepseek-v4-flash)---- 原样保留(调度与句柄映射都认它);
 *   - 显示名('Solar Pro 4')---- 内置 catalog 里没有这个写法,必须落回目录 key:
 *     白名单会拒, 会话也会绑错模型.
 *
 * 查不到映射时原样返回:宁可让它照旧走白名单报错,也不猜一个模型出来.
 * @param {any} this 账号池(runtimes)
 * @param {string} model
 * @returns {string}
 */
export function resolveModelAlias(this: any, model: any) {
  if (typeof model !== 'string') return model
  const key = model.trim()
  if (!key) return model
  // 已是目录 key:服务端标识,原样用.
  if (/^m-[0-9a-z]+$/i.test(key)) return key
  // 已是句柄:交由 catalog.handleFor 原样透传.
  if (key.startsWith('fbm1.')) return key
  // 显示名 → 目录 key(大小写/首尾空白不敏感).
  const byName = this._modelKeyForName(key)
  if (byName) return byName
  return model
}
