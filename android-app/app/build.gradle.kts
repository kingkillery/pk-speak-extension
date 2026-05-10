import com.android.build.gradle.internal.api.BaseVariantOutputImpl

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.dagger.hilt.android")
    id("org.jetbrains.kotlin.kapt")
}

android {
    namespace = "com.pkkidking.pispeak"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pkkidking.pispeak"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "DEFAULT_BASE_URL", "\"http://100.76.136.91:8767/\"")
        buildConfigField("int", "REMOTE_PORT", "8767")
        buildConfigField("String", "TAILSCALE_APPSERVER_IP", "\"100.76.136.91\"")
        buildConfigField("String", "TAILSCALE_MAC_IP", "\"100.76.176.119\"")
        buildConfigField("String", "LAN_MSI_IP", "\"10.0.0.117\"")
        buildConfigField("String", "BLUETOOTH_REMOTE_IP", "\"192.168.44.1\"")
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            isMinifyEnabled = false
            buildConfigField("String", "DEFAULT_BASE_URL", "\"http://100.76.136.91:8767/\"")
            buildConfigField("int", "REMOTE_PORT", "8767")
            buildConfigField("String", "TAILSCALE_APPSERVER_IP", "\"100.76.136.91\"")
            buildConfigField("String", "TAILSCALE_MAC_IP", "\"100.76.176.119\"")
            buildConfigField("String", "LAN_MSI_IP", "\"10.0.0.117\"")
            buildConfigField("String", "BLUETOOTH_REMOTE_IP", "\"192.168.44.1\"")
        }
        create("staging") {
            initWith(getByName("release"))
            applicationIdSuffix = ".staging"
            versionNameSuffix = "-staging"
            signingConfig = signingConfigs.getByName("debug")
            buildConfigField("String", "DEFAULT_BASE_URL", "\"http://100.76.136.91:8767/\"")
            buildConfigField("int", "REMOTE_PORT", "8767")
            buildConfigField("String", "TAILSCALE_APPSERVER_IP", "\"100.76.136.91\"")
            buildConfigField("String", "TAILSCALE_MAC_IP", "\"100.76.176.119\"")
            buildConfigField("String", "LAN_MSI_IP", "\"10.0.0.117\"")
            buildConfigField("String", "BLUETOOTH_REMOTE_IP", "\"192.168.44.1\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            buildConfigField("String", "DEFAULT_BASE_URL", "\"http://100.76.136.91:8767/\"")
            buildConfigField("int", "REMOTE_PORT", "8767")
            buildConfigField("String", "TAILSCALE_APPSERVER_IP", "\"100.76.136.91\"")
            buildConfigField("String", "TAILSCALE_MAC_IP", "\"100.76.176.119\"")
            buildConfigField("String", "LAN_MSI_IP", "\"10.0.0.117\"")
            buildConfigField("String", "BLUETOOTH_REMOTE_IP", "\"192.168.44.1\"")
        }
    }

    applicationVariants.all {
        outputs.all {
            val output = this as BaseVariantOutputImpl
            val prefix = when (name) {
                "debug" -> "PiSpeak-dev"
                "staging" -> "PiSpeak-staging"
                "release" -> "PiSpeak-prod"
                else -> "PiSpeak"
            }
            output.outputFileName = "$prefix-${versionName}.apk"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")

    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.hilt:hilt-navigation-compose:1.2.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.navigation:navigation-compose:2.8.5")

    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-moshi:2.11.0")
    implementation("com.squareup.moshi:moshi-kotlin:1.15.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.google.dagger:hilt-android:2.52")
    kapt("com.google.dagger:hilt-compiler:2.52")

    implementation("com.google.zxing:core:3.5.3")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    testImplementation("junit:junit:4.13.2")
}

kapt {
    correctErrorTypes = true
}
