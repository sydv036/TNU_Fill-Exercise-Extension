export function quizModuleId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("cmid")
      ?? (parsed.pathname.includes("/mod/quiz/view.php") ? parsed.searchParams.get("id") ?? undefined : undefined);
  } catch {
    return undefined;
  }
}

export function isSupportedQuizTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://tnu.aum.edu.vn"
      && parsed.pathname.includes("/mod/quiz/view.php")
      && Boolean(parsed.searchParams.get("id"));
  } catch {
    return false;
  }
}

export function isAttemptForTarget(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const currentId = quizModuleId(currentUrl);
    const targetId = quizModuleId(targetUrl);
    return current.pathname.includes("/mod/quiz/attempt.php") && Boolean(currentId && targetId && currentId === targetId);
  } catch {
    return false;
  }
}

export function isReviewForTarget(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const currentId = quizModuleId(currentUrl);
    const targetId = quizModuleId(targetUrl);
    return current.pathname.includes("/mod/quiz/review.php") && Boolean(currentId && targetId && currentId === targetId);
  } catch {
    return false;
  }
}

export function nextReviewPageUrl(document: Document, currentUrl: string): string | undefined {
  const current = new URL(currentUrl);
  const currentPage = Number(current.searchParams.get("page") ?? "0");
  const currentAttempt = current.searchParams.get("attempt");
  const candidates = document.querySelectorAll<HTMLAnchorElement>('a.mod_quiz-next-nav[href], a[rel="next"][href], .pagination a[href], .paging a[href]');
  const valid: Array<{ url: string; page: number }> = [];
  for (const candidate of candidates) {
    try {
      const next = new URL(candidate.getAttribute("href") || candidate.href || "", currentUrl);
      if (!next.pathname.includes("/mod/quiz/review.php") || (next.pathname === current.pathname && next.search === current.search)) continue;
      if (quizModuleId(next.href) !== quizModuleId(currentUrl)) continue;
      const nextAttempt = next.searchParams.get("attempt");
      if (currentAttempt && nextAttempt && currentAttempt !== nextAttempt) continue;
      const nextPage = Number(next.searchParams.get("page"));
      if (!Number.isFinite(nextPage) || nextPage <= currentPage) continue;
      valid.push({ url: next.href, page: nextPage });
    } catch { /* Bỏ qua liên kết điều hướng không hợp lệ. */ }
  }
  return valid.sort((left, right) => left.page - right.page)[0]?.url;
}
