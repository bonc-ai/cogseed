/**
 * 贡献包的**可选图标**校验 —— Hub 侧 `features/contributions/iconRules.ts` 的客户端镜像。
 *
 * ## 为什么客户端要重跑一遍
 *
 * 图标规则只在 Hub 的**提交复检**里执行（`checkIcon`），而客户端准入（`admitContribution`）
 * 此前只跑本地红线 + 深扫。结果是贡献者看到「准入通过 / 三项声明齐全 / 确认预览全绿」，
 * 点提交却被 `PACKAGE_REJECTED / icon.duplicate` 拒绝（2026-10-27 报告 HUB-2）。规则本身很便宜
 * （路径 + 头部字节），没有理由把它留到最后一步才发现。
 *
 * ## 与 Hub 的差异：只做**静态判定**
 *
 * Hub 用 `sharp` 解码，因此还能发现「伪造扩展名的非图片」这种内容级问题。客户端不引入图片
 * 解码依赖（Electron 主进程的 `nativeImage` 不适合做安全判定，也不该成为新的攻击面），
 * 这里只读**头部字节**：PNG 的 IHDR / acTL、WebP 的 VP8 / VP8L / VP8X（含 ANIM/ANMF）。
 * 覆盖范围与判据逐条对应 Hub：
 *
 * | 规则 | Hub | 客户端 |
 * |---|---|---|
 * | `icon.duplicate`：固定位置之外的 `icon.*` 副本 | ✅ | ✅ |
 * | `icon.duplicate`：多个候选（`assets/icon.png` + `assets/icon.webp`） | ✅ | ✅ |
 * | `icon.location`：候选位置外的图标 | ✅ | ✅ |
 * | `icon.format`：SVG/XML、动图、扩展名与真实格式不符 | ✅ 解码 | ✅ 头部嗅探 |
 * | `icon.decode`：无法解码 | ✅ | ⚠️ 只判「头部不成立」，内容损坏留给 Hub |
 * | `icon.size` / `icon.dimension`：字节数与宽高上限 | ✅ | ✅（仅当头部可读） |
 *
 * 头部读不出来的候选**不静默放行**：它按 `icon.decode` 阻断，与 Hub 的判定方向一致（Hub 那边
 * 是 `sharp` 抛错 → 同样阻断）。这样两端不会出现「客户端绿、服务端红」。
 *
 * 阈值是 Hub 的**候选值**（`specs/010-client-contribution/contracts/c06-icons.md` 尚未冻结），
 * 冻结后两处必须同时改——和 `skill-sentry` 的规则包是同一个道理：判据只能有一个来源。
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/** 与 Hub `ICON_CANDIDATE` 逐项一致（未冻结的候选阈值）。 */
export const ICON_RULES = {
  allowedPaths: ['assets/icon.png', 'assets/icon.webp'],
  maxBytes: 256 * 1024,
  maxDimension: 512,
  allowedFormats: ['png', 'webp'],
} as const

/** 固定位置上的图标（候选位置集合）。 */
const ICON_AT_CANDIDATE_PATH = /^assets\/icon\.[^/]+$/
/** 任意位置的 `icon.<ext>`：用于识别「额外副本」。 */
const ICON_BASENAME = /^icon\.[^/]+$/

export type IconIssueRule =
  | 'icon.decode'
  | 'icon.dimension'
  | 'icon.duplicate'
  | 'icon.format'
  | 'icon.location'
  | 'icon.size'

export interface IconIssue {
  code: 'ICON_INVALID' | 'ICON_LIMIT'
  rule: IconIssueRule
  message: string
  /** 包内相对路径 */
  entry: string
}

export interface IconFact {
  animated: boolean
  format: 'png' | 'webp'
  height: number
  path: string
  sizeBytes: number
  width: number
}

export interface IconCheckResult {
  icon: IconFact | null
  issues: IconIssue[]
}

interface SniffedImage {
  animated: boolean
  format: 'png' | 'webp'
  height: number
  width: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_ANIMATION_CHUNK = Buffer.from('acTL', 'ascii')

/** PNG：IHDR 给出宽高；`acTL` 出现即动图（APNG）。 */
const sniffPng = (bytes: Buffer): SniffedImage | null => {
  if (bytes.length < 33) return null
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  // `acTL` 在 IDAT 之前出现；整段包含式搜索足够（误命中需要文件里恰好出现这 4 字节）
  return { animated: bytes.includes(PNG_ANIMATION_CHUNK), format: 'png', height, width }
}

/** WebP：按 VP8X / VP8L / VP8 三种位流分别取宽高，并识别 ANIM/ANMF。 */
const sniffWebp = (bytes: Buffer): SniffedImage | null => {
  if (bytes.length < 30) return null
  if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF') return null
  if (bytes.subarray(8, 12).toString('ascii') !== 'WEBP') return null
  const chunk = bytes.subarray(12, 16).toString('ascii')

  if (chunk === 'VP8X') {
    // 扩展格式：flags(1) + reserved(3) + canvasWidth-1(3) + canvasHeight-1(3)
    const flags = bytes.readUInt8(20)
    const width = bytes.readUIntLE(24, 3) + 1
    const height = bytes.readUIntLE(27, 3) + 1
    const animated = (flags & 0x02) !== 0 || bytes.includes(Buffer.from('ANMF', 'ascii'))
    return { animated, format: 'webp', height, width }
  }

  if (chunk === 'VP8L') {
    // 无损：signature(0x2F) + 14bit width-1 + 14bit height-1
    if (bytes.readUInt8(20) !== 0x2f) return null
    const bits = bytes.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return { animated: false, format: 'webp', height, width }
  }

  if (chunk === 'VP8 ') {
    // 有损：frame tag(3) + start code 9D 01 2A + 14bit width + 14bit height
    const dataStart = 20
    if (bytes.length < dataStart + 10) return null
    if (bytes.readUInt8(dataStart + 3) !== 0x9d || bytes.readUInt8(dataStart + 4) !== 0x01) return null
    if (bytes.readUInt8(dataStart + 5) !== 0x2a) return null
    const width = bytes.readUInt16LE(dataStart + 6) & 0x3fff
    const height = bytes.readUInt16LE(dataStart + 8) & 0x3fff
    return { animated: false, format: 'webp', height, width }
  }

  return null
}

/** 读头部字节判定真实格式与尺寸；读不出来返回 `null`（调用方按「无法解码」阻断）。 */
export const sniffIconBytes = (bytes: Buffer): SniffedImage | null =>
  sniffPng(bytes) ?? sniffWebp(bytes)

const basenameOf = (relativePath: string): string => relativePath.slice(relativePath.lastIndexOf('/') + 1)

/** 递归列出目录下的普通文件（包内相对路径，`/` 分隔，按码点排序保证确定性）。 */
const listFiles = async (root: string): Promise<string[]> => {
  const found: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relativePath)
      else if (entry.isFile()) found.push(relativePath)
    }
  }
  await walk(root, '')
  return found.sort()
}

/** 内容嗅探：SVG / XML 必须在解码前拦住，否则会被归成「文件坏了」而不是「格式不允许」。 */
const looksLikeSvg = (bytes: Buffer): boolean => {
  const head = bytes
    .subarray(0, 512)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
  return /^(<\?xml|<svg)/i.test(head)
}

/**
 * 校验贡献副本里的可选图标。**无图标合法**（`{ icon: null, issues: [] }`）。
 *
 * 判定顺序与 Hub 一致：先收集副本（`icon.duplicate`），再看候选数量与位置，最后才是格式、
 * 尺寸与上限。顺序承重：一个放在包根的 `icon.png` 应当被说成「多余的副本」，而不是
 * 「位置不合法」——两者的修复动作不同（删掉它 vs 挪到 `assets/`）。
 */
export const checkContributionIcon = async (dir: string): Promise<IconCheckResult> => {
  const issues: IconIssue[] = []
  let files: string[]
  try {
    files = await listFiles(dir)
  } catch {
    // 目录都读不出来时交给后续步骤报错，不在图标这一步伪造结论。
    return { icon: null, issues }
  }

  const candidates = files.filter((file) => ICON_AT_CANDIDATE_PATH.test(file))
  const extraCopies = files.filter(
    (file) => ICON_BASENAME.test(basenameOf(file)) && !ICON_AT_CANDIDATE_PATH.test(file),
  )

  for (const extra of extraCopies) {
    issues.push({
      code: 'ICON_INVALID',
      entry: extra,
      message: '包内含固定位置之外的图标副本，无法确定以哪一份为准；请只保留 assets/icon.png 或 assets/icon.webp',
      rule: 'icon.duplicate',
    })
  }

  if (candidates.length === 0) return { icon: null, issues }

  if (candidates.length > 1) {
    for (const candidate of candidates.slice(1)) {
      issues.push({
        code: 'ICON_INVALID',
        entry: candidate,
        message: '包内含多于一个图标，至多允许一个',
        rule: 'icon.duplicate',
      })
    }
    return { icon: null, issues }
  }

  const candidate = candidates[0]!
  if (!(ICON_RULES.allowedPaths as readonly string[]).includes(candidate)) {
    issues.push({
      code: 'ICON_INVALID',
      entry: candidate,
      message: `图标位置须为 ${ICON_RULES.allowedPaths.join(' 或 ')}，实际为 ${candidate}`,
      rule: 'icon.location',
    })
    return { icon: null, issues }
  }

  const bytes = await readFile(path.join(dir, candidate))

  if (looksLikeSvg(bytes)) {
    issues.push({
      code: 'ICON_INVALID',
      entry: candidate,
      message: '图标内容为 SVG / XML，不在允许格式内（只接受 PNG 或静态 WebP）',
      rule: 'icon.format',
    })
    return { icon: null, issues }
  }

  const sniffed = sniffIconBytes(bytes)
  if (sniffed === null) {
    issues.push({
      code: 'ICON_INVALID',
      entry: candidate,
      message: '图标的头部字节不是可识别的 PNG / WebP：可能是伪造扩展名的非图片，或文件已损坏',
      rule: 'icon.decode',
    })
    return { icon: null, issues }
  }

  if (!(ICON_RULES.allowedFormats as readonly string[]).includes(sniffed.format)) {
    issues.push({
      code: 'ICON_INVALID',
      entry: candidate,
      message: `图标实际格式为 ${sniffed.format}，允许 ${ICON_RULES.allowedFormats.join(' / ')}`,
      rule: 'icon.format',
    })
    return { icon: null, issues }
  }

  if (sniffed.animated) {
    issues.push({
      code: 'ICON_INVALID',
      entry: candidate,
      message: '图标为动图，只接受静态图',
      rule: 'icon.format',
    })
    return { icon: null, issues }
  }

  // 扩展名与真实格式必须相互印证（Hub 侧实测过「PNG 字节命名为 .webp」会被放行）
  const extension = candidate.slice(candidate.lastIndexOf('.') + 1).toLowerCase()
  if (extension !== sniffed.format) {
    issues.push({
      code: 'ICON_INVALID',
      entry: candidate,
      message: `图标扩展名 .${extension} 与实际格式 ${sniffed.format} 不一致`,
      rule: 'icon.format',
    })
    return { icon: null, issues }
  }

  if (bytes.byteLength > ICON_RULES.maxBytes) {
    issues.push({
      code: 'ICON_LIMIT',
      entry: candidate,
      message: `图标 ${bytes.byteLength} 字节超过上限 ${ICON_RULES.maxBytes} 字节`,
      rule: 'icon.size',
    })
  }

  if (sniffed.width > ICON_RULES.maxDimension || sniffed.height > ICON_RULES.maxDimension) {
    issues.push({
      code: 'ICON_LIMIT',
      entry: candidate,
      message: `图标尺寸 ${sniffed.width}×${sniffed.height} 超过上限 ${ICON_RULES.maxDimension}×${ICON_RULES.maxDimension}`,
      rule: 'icon.dimension',
    })
  }

  if (issues.length > 0) return { icon: null, issues }

  return {
    icon: {
      animated: false,
      format: sniffed.format,
      height: sniffed.height,
      path: candidate,
      sizeBytes: bytes.byteLength,
      width: sniffed.width,
    },
    issues,
  }
}
