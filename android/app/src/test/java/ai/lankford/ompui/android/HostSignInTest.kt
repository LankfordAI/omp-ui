package ai.lankford.ompui.android

import org.junit.Assert.assertEquals
import org.junit.Test

class HostSignInTest {
    private val password = SignIn.Password("pw")
    private val token = SignIn.Token("tok")
    private val cookie = "omp_ui_token=abc; Path=/; HttpOnly; SameSite=Strict"

    @Test fun classifiesPasswordResponses() {
        assertEquals(
            SignInResult.Accepted(listOf(cookie)),
            HostSignIn.classify(password, 302, listOf("other=1; Path=/", cookie, "omp_ui_token_x=2"), null),
        )
        assertEquals(SignInResult.Failed(302), HostSignIn.classify(password, 302, listOf("other=1"), null))
        assertEquals(SignInResult.Rejected, HostSignIn.classify(password, 401, emptyList(), null))
        assertEquals(SignInResult.Rejected, HostSignIn.classify(password, 400, emptyList(), null))
        assertEquals(SignInResult.Throttled(12), HostSignIn.classify(password, 429, emptyList(), " 12 "))
        assertEquals(SignInResult.Throttled(null), HostSignIn.classify(password, 429, emptyList(), "soon"))
        assertEquals(SignInResult.Failed(500), HostSignIn.classify(password, 500, emptyList(), null))
    }

    @Test fun classifiesTokenResponses() {
        assertEquals(SignInResult.Accepted(listOf(cookie)), HostSignIn.classify(token, 200, listOf(cookie), null))
        assertEquals(SignInResult.Failed(200), HostSignIn.classify(token, 200, emptyList(), null))
        assertEquals(SignInResult.Rejected, HostSignIn.classify(token, 401, emptyList(), null))
    }
}
