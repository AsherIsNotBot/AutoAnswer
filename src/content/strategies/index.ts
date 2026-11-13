import { BaseStrategy } from './BaseStrategy'
import { XueXiTongStrategy } from './XueXiTong'
import { ZhiHuiShuStrategy } from './ZhiHuiShu'

export { BaseStrategy, questionTypeLabel } from './BaseStrategy'
export { XueXiTongStrategy } from './XueXiTong'
export { ZhiHuiShuStrategy } from './ZhiHuiShu'

/** 按域名选择平台策略，未命中返回 null。 */
export function createStrategy(host: string): BaseStrategy | null {
  if (host.includes('chaoxing.com')) return new XueXiTongStrategy()
  if (host.includes('zhihuishu.com')) return new ZhiHuiShuStrategy()
  return null
}
