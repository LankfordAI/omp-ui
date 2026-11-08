plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseVersion = providers.gradleProperty("releaseVersion")
val appVersion = releaseVersion.orElse("0.1.0").get()
val versionParts = Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)").matchEntire(appVersion)
    ?: error("releaseVersion must be a stable major.minor.patch version")
val numbers = versionParts.groupValues.drop(1).map { it.toLongOrNull() ?: error("releaseVersion is out of range") }
require(numbers[0] <= 2099 && numbers[1] <= 999 && numbers[2] <= 999) { "releaseVersion is out of Android versionCode range" }
val appVersionCode = (numbers[0] * 1_000_000 + numbers[1] * 1_000 + numbers[2] + 1).toInt()
val releaseKeystore = providers.environmentVariable("ANDROID_KEYSTORE_PATH")
val releasePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD")

android {
    namespace = "ai.lankford.ompui.android"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "ai.lankford.ompui.android"
        minSdk = 29
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { buildConfig = true }
    signingConfigs {
        create("release") {
            releaseKeystore.orNull?.let { storeFile = file(it) }
            storePassword = releasePassword.orNull
            keyAlias = "omp-ui-android"
            keyPassword = releasePassword.orNull
        }
    }
    buildTypes {
        getByName("release") {
            isDebuggable = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

val validateReleaseInputs = tasks.register("validateReleaseInputs") {
    doLast {
        require(releaseVersion.isPresent) { "Release builds require -PreleaseVersion=major.minor.patch" }
        require(releaseKeystore.orNull?.let { file(it).isFile } == true) { "ANDROID_KEYSTORE_PATH must name the release keystore" }
        require(!releasePassword.orNull.isNullOrBlank()) { "ANDROID_KEYSTORE_PASSWORD is required for release builds" }
    }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(validateReleaseInputs) }

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("androidx.window:window:1.4.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
