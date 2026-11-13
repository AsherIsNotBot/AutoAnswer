import { BaseStrategy, type StrategySelectors } from './BaseStrategy'

/**
 * 学习通（超星）解析策略。
 * 兼容练习页的 .questionLi / .mark_name / .num_option，
 * 以及考试页常见的 .TiMu / .Zy_TItle / .answerBg 结构。
 */
export class XueXiTongStrategy extends BaseStrategy {
  readonly platform = '学习通'

  protected readonly selectors: StrategySelectors = {
    question: ['.questionLi', '.TiMu', '.Zy_TItle .TiMu'],
    stem: ['.mark_name', '.Zy_TItle .fl', '.Zy_TItle', '.question-title'],
    option: ['.num_option', '.stem_answer .answerBg', '.answerBg'],
    blank: ['textarea', 'input[type="text"]'],
  }
}
