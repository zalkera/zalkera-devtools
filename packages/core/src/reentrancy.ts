/**
 * **한 번에 하나만 돈다 — 재진입 가드.**
 *
 * ■ 왜 core 에 있나
 *   이 가드는 확장(`extension.ts`)에서 태어났는데, 거기서는 **시험도 검사기도 못 닿는다**(VS Code
 *   API 가 필요하다). 실측으로, 가드 조건을 통째로 무력화해도 시험 297건과 `npm run verify` 의 검사기가 전부
 *   초록이었다 — 가드가 아무것도 못박고 있지 않았다. 판정만 여기로 내려 시험이 물게 한다.
 *
 * ■ 무엇을 막나
 *   소스 받기(예제로 시작 · 사이트 소스 받기)는 같은 폴더에 아카이브를 푼다. 겹치면 두 가지가 난다:
 *   ⑴ 같은 이름 파일에 두 꾸러미가 번갈아 쓰여 **바이트가 찢어진다**
 *   ⑵ 한쪽이 실패하면 그쪽 롤백이 자기 스냅샷 이후 생긴 것 **전부**를 지우므로, 다른 쪽이
 *      「받았습니다」라고 알린 파일까지 함께 날아간다.
 *   최대 15분짜리 다운로드를 멈출 방법이 없으니 **다시 누르는 것이 자연스러운 반응**이다.
 *
 * ■ 한계 — 창을 못 넘는다
 *   이 가드는 **프로세스 안**에서만 산다. VS Code 는 창마다 확장 호스트가 따로이므로, 새 창을 열어
 *   같은 폴더로 받으면 막지 못한다. 폴더 자체를 잠그려면 파일시스템 잠금이 필요하고 그건 별건이다.
 */

/** 이미 돌고 있어 실행하지 않았다. */
export const BUSY = Symbol("busy");

/**
 * `run` 이 도는 동안 같은 가드로 들어오는 호출을 막는다.
 *
 * 이미 돌고 있으면 [BUSY] 를 돌려준다 — 부르는 쪽이 사람에게 무엇을 말할지 정한다.
 * `run` 이 던져도 **반드시** 가드를 푼다: 성공 경로에서만 풀면 폴더 선택 취소 한 번에 영영
 * 잠겨, 창을 새로 열 때까지 「진행 중」만 반복한다(형제 가드가 실제로 겪은 사고다).
 */
export interface ReentrancyGuard {
  /** 이미 돌고 있으면 [BUSY] 를 돌려준다 — 부르는 쪽이 사람에게 무엇을 말할지 정한다. */
  run<T>(run: () => Promise<T>): Promise<T | typeof BUSY>;
  /**
   * 지금 돌고 있는가.
   *
   * 「막는다」 말고 **「돌고 있느냐」를 묻는 자리**가 따로 있다 — 미리보기를 준비하는 동안 로그아웃을
   * 거절하는 것이 그 자리다. 그 판정이 확장 안 불리언으로 살면 시험이 못 닿는다.
   */
  readonly busy: boolean;
}

export function createReentrancyGuard(): ReentrancyGuard {
  let running = false;
  return {
    async run<T>(run: () => Promise<T>): Promise<T | typeof BUSY> {
      if (running) return BUSY;
      running = true;
      try {
        return await run();
      } finally {
        running = false;
      }
    },
    get busy() {
      return running;
    },
  };
}
