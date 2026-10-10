/** local-file:// 的单一构造器（full_20261011 M3-P1-2/X1）：裸拼路径曾让含 % 的
 *  路径触发 serve 端 fail-closed 遍历门（decodeURIComponent 抛错即 403）、含 #
 *  的路径把后半截切进 fragment 读错文件。encodeURI 保留 / 与 :，正适合整路径，
 *  但它刻意保留 URL 结构分隔符——# 与 ? 必须手工补转义（fragment/query 切分），
 *  % 与空格 encodeURI 自带；serve 端 new URL + pathname 解码还原。所有生产
 *  local-file:// 字符串的调用点必须走这里——手拼一处，403 就从那处回来。 */
export function localFileUrl(path: string, query?: string): string {
  const p = encodeURI(path.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')
  return `local-file://${p}${query ? `?${query}` : ''}`
}
