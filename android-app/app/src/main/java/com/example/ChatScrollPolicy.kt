package com.example

/**
 * Decides whether the Studio conversation should keep auto-scrolling ("follow the tail")
 * when new content arrives. The list follows only while the reader is already at, or
 * within [tailSlack] items of, the bottom — so scrolling up to read history is never
 * hijacked by an incoming reply.
 */
fun shouldFollowConversationTail(
    lastVisibleItemIndex: Int,
    totalItemCount: Int,
    tailSlack: Int = 2,
): Boolean {
    if (totalItemCount <= 0) return true
    if (lastVisibleItemIndex < 0) return true
    return lastVisibleItemIndex >= totalItemCount - 1 - tailSlack
}
