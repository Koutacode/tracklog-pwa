package com.tracklog.assist;

import static org.junit.Assert.*;

import org.junit.Test;

/**
 * Example local unit test, which will execute on the development machine (host).
 *
 * @see <a href="http://d.android.com/tools/testing">Testing documentation</a>
 */
public class ExampleUnitTest {

    @Test
    public void addition_isCorrect() throws Exception {
        assertEquals(4, 2 + 2);
    }

    @Test
    public void residentNotificationText_isExact() {
        assertEquals("位置記録中", ResidentLocationService.NOTIFICATION_TEXT);
        assertEquals(0f, ResidentLocationService.MIN_DISTANCE_METERS, 0f);
    }

    @Test
    public void activeTripId_isNormalizedBeforePersistence() {
        assertEquals("trip-123", ResidentLocationState.normalizeTripId("  trip-123  "));
        assertEquals("", ResidentLocationState.normalizeTripId(null));
    }

    @Test
    public void routePauseThreshold_isExclusive() {
        assertTrue(ResidentLocationState.shouldRecordRouteAt(10_000L, 9_999L));
        assertFalse(ResidentLocationState.shouldRecordRouteAt(10_000L, 10_000L));
        assertTrue(ResidentLocationState.shouldRecordRouteAt(0L, 10_000L));
    }

    @Test
    public void residentEligibility_doesNotRequireActiveTrip() {
        assertTrue(ResidentLocationState.isEligibleState(true, true, true));
        assertFalse(ResidentLocationState.isEligibleState(false, true, true));
        assertFalse(ResidentLocationState.isEligibleState(true, false, true));
        assertFalse(ResidentLocationState.isEligibleState(true, true, false));
    }

    @Test
    public void blockedAuthorization_keepsServiceEligibleButDisablesUpload() {
        ResidentLocationState.RoutineReconcilePolicy policy =
                ResidentLocationState.routineReconcilePolicy(true, true, true, true);

        assertTrue(policy.enabled);
        assertTrue(policy.preserveAuthorization);
        assertTrue(policy.preserveBlockedFingerprint);
        assertTrue(policy.authorizationBlocked);
        assertFalse(ResidentLocationState.isUploadAllowedState(true, true));
        assertTrue(ResidentLocationState.isUploadAllowedState(true, false));
        assertFalse(ResidentLocationState.isUploadAllowedState(false, false));
    }

    @Test
    public void routineReconcile_ignoresEmptyWebAuthorizationAndKeepsConfiguredNativeAuth() {
        ResidentLocationState.Authorization nativeAuthorization =
                ResidentLocationState.Authorization.create(
                        "https://example.supabase.co",
                        "anon",
                        "native-access",
                        "native-refresh",
                        "device",
                        1L
                );
        ResidentLocationState.Authorization emptyWebAuthorization =
                ResidentLocationState.Authorization.create("", "", "", "", "", 2L);
        ResidentLocationState.RoutineReconcilePolicy policy =
                ResidentLocationState.routineReconcilePolicy(
                        true,
                        true,
                        nativeAuthorization.isConfigured(),
                        false
                );

        assertFalse(emptyWebAuthorization.isConfigured());
        assertTrue(policy.enabled);
        assertTrue(policy.preserveAuthorization);
        assertTrue(policy.preserveBlockedFingerprint);
    }

    @Test
    public void authorizationCredentialCas_rejectsOld403AgainstNewAuthorization() {
        ResidentLocationState.Authorization oldAuthorization =
                ResidentLocationState.Authorization.create(
                        "https://example.supabase.co",
                        "anon",
                        "old-access",
                        "old-refresh",
                        "device",
                        1L
                );
        ResidentLocationState.Authorization newAuthorization =
                ResidentLocationState.Authorization.create(
                        "https://example.supabase.co",
                        "anon",
                        "new-access",
                        "new-refresh",
                        "device",
                        2L
                );

        assertTrue(ResidentLocationState.authorizationCredentialsMatch(
                oldAuthorization,
                oldAuthorization
        ));
        assertFalse(ResidentLocationState.authorizationCredentialsMatch(
                oldAuthorization,
                newAuthorization
        ));
    }

    @Test
    public void blockedFingerprint_isKeptOnlyForTheSameAuthorization() {
        ResidentLocationState.Authorization first = ResidentLocationState.Authorization.create(
                "https://example.supabase.co",
                "anon",
                "access-1",
                "refresh-1",
                "device",
                1L
        );
        ResidentLocationState.Authorization second = ResidentLocationState.Authorization.create(
                "https://example.supabase.co",
                "anon",
                "access-2",
                "refresh-2",
                "device",
                2L
        );

        assertTrue(ResidentLocationState.shouldRemainAuthorizationBlocked(
                first.fingerprint(),
                first.fingerprint()
        ));
        assertFalse(ResidentLocationState.shouldRemainAuthorizationBlocked(
                first.fingerprint(),
                second.fingerprint()
        ));
        assertFalse(ResidentLocationState.shouldRemainAuthorizationBlocked("", first.fingerprint()));
    }

    @Test
    public void accessJwt_requiresAtLeastFiveMinutesRemaining() {
        long nowMs = 1_700_000_000_000L;
        assertTrue(ResidentLocationUploader.hasMinimumExpirationValidity(
                1_700_000_300_000L,
                nowMs,
                300_000L
        ));
        assertFalse(ResidentLocationUploader.hasMinimumExpirationValidity(
                1_700_000_299_000L,
                nowMs,
                300_000L
        ));
        assertFalse(ResidentLocationUploader.hasMinimumExpirationValidity(
                0L,
                nowMs,
                300_000L
        ));
        assertFalse(ResidentLocationUploader.hasMinimumJwtValidity(
                "not-a-jwt",
                nowMs,
                300_000L
        ));
    }

    @Test
    public void nativeAuthorizationRefresh_isForcedAfterAnAuthenticated401() {
        assertFalse(ResidentLocationUploader.shouldRefreshAuthorization(true, false, true, false));
        assertTrue(ResidentLocationUploader.shouldRefreshAuthorization(true, false, true, true));
        assertTrue(ResidentLocationUploader.shouldRefreshAuthorization(true, false, false, false));
        assertFalse(ResidentLocationUploader.shouldRefreshAuthorization(true, true, false, true));
        assertFalse(ResidentLocationUploader.shouldRefreshAuthorization(false, false, false, true));
    }

    @Test
    public void uploadPolicy_stopsOnlyOnExplicitAuthorizationRejection() {
        assertEquals(
                ResidentLocationUploadPolicy.Action.REFRESH,
                ResidentLocationUploadPolicy.classifyStatus(401, false)
        );
        assertEquals(
                ResidentLocationUploadPolicy.Action.RETRY,
                ResidentLocationUploadPolicy.classifyStatus(401, true)
        );
        assertEquals(
                ResidentLocationUploadPolicy.Action.STOP_AUTHORIZATION,
                ResidentLocationUploadPolicy.classifyStatus(403, false)
        );
        assertEquals(
                ResidentLocationUploadPolicy.Action.RETRY,
                ResidentLocationUploadPolicy.classifyStatus(503, false)
        );
        assertTrue(ResidentLocationUploadPolicy.isPermanentRefreshFailure(
                400,
                "{\"error_code\":\"refresh_token_already_used\",\"msg\":\"Invalid Refresh Token: Already Used\"}"
        ));
        assertFalse(ResidentLocationUploadPolicy.isPermanentRefreshFailure(401, "temporary token race"));
        assertTrue(ResidentLocationUploadPolicy.isPermanentRefreshFailure(400, "refresh_token_not_found"));
        assertTrue(ResidentLocationUploadPolicy.isPermanentRefreshFailure(401, "Invalid Refresh Token"));
        assertTrue(ResidentLocationUploadPolicy.isPermanentRefreshFailure(403, ""));
        assertFalse(ResidentLocationUploadPolicy.isPermanentRefreshFailure(429, ""));
        assertFalse(ResidentLocationUploadPolicy.isPermanentRefreshFailure(500, ""));
    }

    @Test
    public void uploadPolicy_enforcesThirtySecondInterval() {
        assertFalse(ResidentLocationUploadPolicy.shouldAttempt(29_999L, 1L));
        assertTrue(ResidentLocationUploadPolicy.shouldAttempt(30_001L, 1L));
        assertTrue(ResidentLocationUploadPolicy.shouldAttempt(10L, 0L));
    }

    @Test
    public void supabaseBaseUrl_requiresHttps() {
        assertEquals(
                "https://example.supabase.co",
                ResidentLocationUploadPolicy.normalizeBaseUrl(" https://example.supabase.co/ ")
        );
        assertEquals("", ResidentLocationUploadPolicy.normalizeBaseUrl("http://example.test"));
        assertEquals("", ResidentLocationUploadPolicy.normalizeBaseUrl("not-a-url"));
    }

}
