# iOS app

Placeholder. The iOS app is SwiftUI with native components and MapLibre Native (Swift Package Manager), with iPhone Duo support through the iOS 27.1 hinge, ArrangementView and vertical toolbar APIs. It needs a Mac with Xcode 27.1 or later.

The Xcode project will link the shared core as `Shared.xcframework`, built by Gradle:

```bash
./gradlew :shared:assembleSharedXCFramework
```

`iosApp/iosApp/` has the starting Swift sources; the Xcode project is created on the Mac.
