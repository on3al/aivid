import dotenv from 'dotenv';  // For environment variables
import fs from 'fs';  // File system
import path from 'path';  // For handling file paths
import { fileURLToPath } from 'url';  // To define __dirname in ES modules
import { OpenAI } from 'openai';  // OpenAI API client
import ffmpeg from 'fluent-ffmpeg';  // FFMPEG for video manipulation
import yargs from 'yargs';  // CLI argument parsing
import axios from 'axios';  // HTTP requests for downloading images/audio
import { hideBin } from 'yargs/helpers';
import moment from 'moment';  // For timestamp formatting

// Define __dirname in ES module scope
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Initialize OpenAI with configuration
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    organization: process.env.OPENAI_API_ORG,
});

// Parse CLI arguments using yargs
const argv = yargs(hideBin(process.argv))
    .option('file', {
        alias: 'f',
        description: 'Path to the file containing the prompt',
        type: 'string',
    })
    .option('runname', {
        alias: 'r',
        description: 'Name for the output folder',
        type: 'string',
        default: 'run'
    })
    .argv;

// Get current timestamp in 'YYYYMMDD-HHmmss' format
const timestamp = moment().format('YYYYMMDD-HHmmss');

// Create output directory based on runname and timestamp
const outputDir = path.join(__dirname, 'out', `${argv.runname}-${timestamp}`);
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// Get the prompt from the file or stdin
let prompt;
if (argv.file) {
    prompt = fs.readFileSync(argv.file, 'utf-8');
} else {
    prompt = process.stdin.read();
}

// Main function to generate TikTok video and save all artifacts
async function generateTikTokVideo(prompt) {
    try {
        // Step 1: Generate the script using OpenAI Chat API in JSON format
        const script = await generateChatScript(prompt);
        const jsonResponse = JSON.parse(script);
        console.log("Generated Script JSON:", JSON.stringify(jsonResponse, null, 2));

        // Save the script to a JSON file
        const scriptFilePath = path.join(outputDir, 'script.json');
        fs.writeFileSync(scriptFilePath, JSON.stringify(jsonResponse, null, 2));
        console.log(`Script saved to: ${scriptFilePath}`);

        // Step 2: Generate images and audio for each scene
        const scenes = jsonResponse.scenes;
        const images = await Promise.all(scenes.map((scene, i) => generateImageForScene(scene.scene_description, i)));
        const audioFiles = await Promise.all(scenes.map((scene, i) => generateSpeech(scene.narration, i)));

        // Step 3: Create video using FFMPEG
        const videoPath = path.join(outputDir, 'output.mp4');
        await createVideo(images, audioFiles, videoPath);
        console.log(`TikTok Video Generated: ${videoPath}`);

    } catch (error) {
        console.error("Error generating video:", error);
    }
}

// Function to generate the script using OpenAI Chat Completion API
async function generateChatScript(prompt) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: "You are a helpful assistant that generates a TikTok video script in JSON format." },
                { role: "user", content: prompt }
            ],
            max_tokens: 1000,
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error("Error generating script:", error);
        throw error;
    }
}

// Function to generate an image using DALL-E 3 and save it
async function generateImageForScene(sceneDescription, sceneNumber) {
    try {
        const response = await openai.images.generate({
            prompt: sceneDescription,
            n: 1,
            model: "dall-e-3",
            quality: "hd",
            size: "1024x1792",
            response_format: "url",
        });

        const imageUrl = response.data[0].url;
        const imageResponse = await axios.get(imageUrl, { responseType: 'stream' });
        const imagePath = path.join(outputDir, `image${sceneNumber}.jpg`);
        const writer = fs.createWriteStream(imagePath);
        imageResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`Generated Image saved to: ${imagePath}`);
        return imagePath;
    } catch (error) {
        console.error("Error generating image:", error);
        throw error;
    }
}

// Function to generate text-to-speech and save it as an mp3 file
async function generateSpeech(text, sceneNumber) {
    try {
        const mp3 = await openai.audio.speech.create({
            model: "tts-1",  // Correct TTS model
            voice: "alloy",  // Chosen voice
            input: text,  // Scene narration text
        });

        const buffer = Buffer.from(await mp3.arrayBuffer());
        const audioPath = path.join(outputDir, `audio${sceneNumber}.mp3`);
        await fs.promises.writeFile(audioPath, buffer);
        console.log(`Generated Audio saved to: ${audioPath}`);

        return audioPath;
    } catch (error) {
        console.error("Error generating speech:", error);
        throw error;
    }
}

// Function to create the video using FFMPEG
async function createVideo(images, audioFiles, output) {
    const command = ffmpeg();

    // Create video for each image and audio file
    for (let i = 0; i < images.length; i++) {
        command.input(images[i])
            .input(audioFiles[i])
            .inputOptions(`-t ${await getAudioDuration(audioFiles[i])}`); // Set the duration to match audio length
    }

    return new Promise((resolve, reject) => {
        command
            .output(output)
            .size('1080x1920')  // 9:16 resolution
            .videoCodec('libx264')
            .audioCodec('aac')
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

// Function to get the duration of an audio file
function getAudioDuration(audioFile) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(audioFile, (err, metadata) => {
            if (err) {
                return reject(err);
            }
            const duration = metadata.format.duration;
            resolve(duration);
        });
    });
}

// Execute the main function with the provided prompt
generateTikTokVideo(prompt);
