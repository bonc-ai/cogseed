/**
 * 认知资产摘要导出的类型契约，零运行时行为。
 *
 * 认知记忆摘要 CognitionMemoryAssetSummary 与正式资产摘要
 * CognitionAssetSummary 是不同类型，不能由 index 的同名本地声明遮蔽
 * 正式摘要的星导出。下面的索引访问保证从 index 导入的正式摘要包含
 * maturity 与 type；类型被遮蔽时，编译会报告缺失字段。
 */
import type { CognitionAssetSummary } from './index';

/** 正式资产摘要的成熟度轴（遮蔽回流时此别名解析失败）。 */
export type FormalCognitionAssetSummaryMaturity = CognitionAssetSummary['maturity'];

/** 正式资产摘要的类型列（同上，双锚防误删单行绕过）。 */
export type FormalCognitionAssetSummaryType = CognitionAssetSummary['type'];
