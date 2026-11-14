import { BaseStrategy } from './BaseStrategy'
import { XueXiTongStrategy } from './XueXiTong'
import { XueXiTongWorkStrategy } from './XueXiTongWork'
import { ZhiHuiShuStrategy } from './ZhiHuiShu'

export { BaseStrategy, questionTypeLabel } from './BaseStrategy'
export { XueXiTongStrategy } from './XueXiTong'
export { XueXiTongWorkStrategy } from './XueXiTongWork'
export { ZhiHuiShuStrategy } from './ZhiHuiShu'

/** 按域名和页面结构选择平台策略，未命中返回 null。 */
export function createStrategy(host: string): BaseStrategy | null {
  if (host.includes('chaoxing.com')) {
    // 作业/考试页：题目在 .singleQuesId .TiMu 中
    if (document.querySelector('.singleQuesId .TiMu')) {
      return new XueXiTongWorkStrategy()
    }
    return new XueXiTongStrategy()
  }
  if (host.includes('zhihuishu.com')) return new ZhiHuiShuStrategy()
  return null
}
