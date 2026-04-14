-keepattributes Signature
-keepattributes *Annotation*
-keep class retrofit2.** { *; }
-keepclasseswithmembers class * {
    @retrofit2.http.* <methods>;
}
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-dontwarn com.google.errorprone.annotations.**
-keep class com.google.crypto.tink.** { *; }
-keep class dagger.hilt.** { *; }
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}
-assumenosideeffects class kotlin.io.ConsoleKt {
    public static void println(...);
}
