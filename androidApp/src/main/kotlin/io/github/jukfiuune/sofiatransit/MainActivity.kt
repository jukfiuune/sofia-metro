package io.github.jukfiuune.sofiatransit

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.github.jukfiuune.sofiatransit.time.SofiaTime
import io.github.jukfiuune.sofiatransit.ui.theme.SofiaTransitTheme
import io.github.jukfiuune.sofiatransit.ui.theme.TransitColors
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            SofiaTransitTheme {
                HomeScreen()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen() {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000 - now % 1000)
            now = System.currentTimeMillis()
        }
    }
    Scaffold(
        topBar = { LargeTopAppBar(title = { Text(stringResource(R.string.app_name)) }) },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .padding(horizontal = 16.dp)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            ClockCard(now)
            LinesCard()
            Text(
                stringResource(R.string.shared_core, platformName),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ClockCard(now: Long) {
    val time = SofiaTime.at(now)
    val service = SofiaTime.serviceTime(now)
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp)) {
            Text(stringResource(R.string.time_in_sofia), style = MaterialTheme.typography.labelLarge)
            Text(time.hhmmss, style = MaterialTheme.typography.displayMedium)
            Text(
                stringResource(R.string.service_day, service.day),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun LinesCard() {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.lines), style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LineBadge("M1", TransitColors.M1, Color.White)
                LineBadge("M2", TransitColors.M2, Color.White)
                LineBadge("M3", TransitColors.M3, Color.White)
                LineBadge("M4", TransitColors.M4, Color.Black)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LineBadge("5", TransitColors.Tram, Color.White)
                LineBadge("2", TransitColors.Trolleybus, Color.White)
                LineBadge("94", TransitColors.Bus, Color.White)
                LineBadge("N1", TransitColors.Night, Color.White)
            }
        }
    }
}

@Composable
private fun LineBadge(name: String, background: Color, content: Color) {
    Surface(color = background, contentColor = content, shape = RoundedCornerShape(8.dp)) {
        Box(Modifier.size(width = 52.dp, height = 36.dp), contentAlignment = Alignment.Center) {
            Text(name, fontWeight = FontWeight.Bold)
        }
    }
}

@Preview
@Composable
private fun HomePreview() {
    SofiaTransitTheme(dynamicColor = false) {
        Surface(Modifier.fillMaxSize()) { HomeScreen() }
    }
}
