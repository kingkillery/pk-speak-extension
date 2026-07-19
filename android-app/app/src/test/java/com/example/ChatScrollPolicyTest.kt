package com.example

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatScrollPolicyTest {

  @Test
  fun followsTailWhenListIsEmptyOrUnmeasured() {
    assertTrue(shouldFollowConversationTail(lastVisibleItemIndex = -1, totalItemCount = 0))
    assertTrue(shouldFollowConversationTail(lastVisibleItemIndex = -1, totalItemCount = 12))
  }

  @Test
  fun followsTailWhenReaderIsAtTheBottom() {
    assertTrue(shouldFollowConversationTail(lastVisibleItemIndex = 19, totalItemCount = 20))
  }

  @Test
  fun followsTailWithinSlackOfTheBottom() {
    assertTrue(shouldFollowConversationTail(lastVisibleItemIndex = 17, totalItemCount = 20, tailSlack = 2))
  }

  @Test
  fun doesNotFollowTailWhenReaderScrolledUp() {
    assertFalse(shouldFollowConversationTail(lastVisibleItemIndex = 5, totalItemCount = 20))
    assertFalse(shouldFollowConversationTail(lastVisibleItemIndex = 16, totalItemCount = 20, tailSlack = 2))
  }

  @Test
  fun singleScreenConversationAlwaysFollows() {
    assertTrue(shouldFollowConversationTail(lastVisibleItemIndex = 3, totalItemCount = 4))
  }
}
