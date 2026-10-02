/** A request, from outside a page, to open one recorded run in it -- the
 *  Admin page's run history opening a user's run in its own tool. The nonce
 *  makes opening the same run twice open it twice. */
export interface RunRequest {
  id: string;
  nonce: number;
}
