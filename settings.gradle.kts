rootProject.name = "sofia-transit"

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// No repositoriesMode: the Kotlin/JS plugin adds its own Node.js and Yarn repositories.
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

include(":shared", ":androidApp")
