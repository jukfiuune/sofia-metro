package io.github.jukfiuune.sofiatransit

import platform.UIKit.UIDevice

actual val platformName: String =
    UIDevice.currentDevice.systemName() + " " + UIDevice.currentDevice.systemVersion
