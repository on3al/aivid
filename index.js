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

        // Step 2: Generate images, audio, and subtitles for each scene
        const scenes = jsonResponse.scenes;
        const images = await Promise.all(scenes.map((scene, i) => generateImageForScene(scene.scene_description, i)));
        const audioFiles = await Promise.all(scenes.map((scene, i) => generateSpeech(scene.narration, i)));
        const subtitleFiles = await Promise.all(scenes.map((_, i) => transcribeAudioToASS(audioFiles[i].audioPath, i)));

        // Step 3: Create individual videos for each image/audio/subtitle pair
        const videoFiles = await createIndividualVideos(images, audioFiles, subtitleFiles);
        console.log(`Individual videos created: ${videoFiles}`);

        // Step 4: Concatenate all individual videos into a single video
        const finalVideoPath = path.join(outputDir, 'final_output.mp4');
        await concatenateVideos(videoFiles, finalVideoPath);
        console.log(`Final TikTok Video Generated: ${finalVideoPath}`);

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


async function createIndividualVideos(images, audioFiles, subtitleFiles) {
    const videoFiles = [];

    for (let i = 0; i < images.length; i++) {
        const videoFilePath = path.join(outputDir, `scene_${i}.mp4`);
        videoFiles.push(videoFilePath);

        const audioDuration = await getAudioDuration(audioFiles[i].audioPath); // Get audio duration first
        const assSubtitlePath = path.resolve(subtitleFiles[i]);  // Use subtitle files passed as separate input

        // Log paths for debugging
        console.log(`Creating video for scene ${i}:`);
        console.log(`Image Path: ${images[i]}`);
        console.log(`Audio Path: ${audioFiles[i].audioPath}`);
        console.log(`ASS Path: ${assSubtitlePath}`);
        console.log(`Video Output Path: ${videoFilePath}`);

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(images[i])
                .loop(1)
                .input(audioFiles[i].audioPath)
                .outputOptions(`-t ${audioDuration}`) // Set duration based on audio length
                .output(videoFilePath)  // Output video file
                .size('1080x1920')  // Set 9:16 resolution
                .videoCodec('libx264')  // Set video codec to H.264
                .audioCodec('aac')  // Set audio codec to AAC
                .outputOptions(`-vf subtitles='${assSubtitlePath}'`)   // Use the full path for the .ass file
                .outputOptions('-r 60')  // Set frame rate to 60 FPS
                .outputOptions('-loglevel verbose') // Add verbose logging for debugging
                .on('end', () => {
                    console.log(`Video created with subtitles at 60 FPS: ${videoFilePath}`);
                    resolve();
                })
                .on('error', (err) => {
                    console.error(`Error creating video with subtitles for scene ${i}:`, err);
                    reject(err);
                })
                .run();
        });
    }

    return videoFiles;
}


// Function to convert verbose JSON transcription to .ass format (per word with correct timestamps)
async function transcribeAudioToASS(audioPath, sceneNumber) {
    try {
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-1",
            response_format: "verbose_json",
            timestamp_granularities: ["word"]
        });

        // Log the full transcription response for debugging
        console.log(`Transcription response for scene ${sceneNumber}:`, transcription);

        // Create the ASS header
        let assContent = `[Script Info]
Title: Scene ${sceneNumber}
Original Script: OpenAI Whisper
ScriptType: v4.00+
PlayDepth: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

        // Extract words from the verbose JSON response
        const words = transcription.words;
        const minDuration = 0.5;  // Minimum duration of 0.5 seconds for each word

        // Loop through each word and create ASS content per word
        let lastEndTime = 0; // Track the end time of the previous word to ensure no overlap

        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const nextWord = words[i + 1];

            // Calculate start and end times
            let startTime = word.start;
            let endTime = word.end;

            // Ensure the start time is not earlier than the previous word's end time
            if (startTime < lastEndTime) {
                startTime = lastEndTime + 0.01;  // Increment by 0.01 seconds to avoid overlap
            }

            // Ensure minimum duration for each word
            if (endTime - startTime < minDuration) {
                endTime = startTime + minDuration;
            }

            // Ensure the end time doesn't overlap with the next word's start time
            if (nextWord && endTime >= nextWord.start) {
                endTime = nextWord.start - 0.01;  // Adjust to avoid overlap with the next word
            }

            // Format the start and end times in ASS format (h:mm:ss.xx)
            const startTimestamp = formatTimeASS(startTime);
            const endTimestamp = formatTimeASS(endTime);

            // Add dialogue line in ASS format
            assContent += `Dialogue: 0,${startTimestamp},${endTimestamp},Default,,0,0,0,,${word.word}\n`;

            // Update the lastEndTime to the current word's end time for the next iteration
            lastEndTime = endTime;
        }

        // Define the path for the .ass file
        const assPath = path.join(outputDir, `subtitles${sceneNumber}.ass`);
        fs.writeFileSync(assPath, assContent);  // Save the .ass content to file

        return assPath;
    } catch (error) {
        console.error("Error transcribing audio:", error);
        throw error;  // Rethrow the error to ensure it's caught upstream
    }
}

// Helper function to format time in ASS style (h:mm:ss.xx)
function formatTimeASS(timeInSeconds) {
    const hours = Math.floor(timeInSeconds / 3600);
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    const centiseconds = Math.floor((timeInSeconds % 1) * 100);  // ASS uses centiseconds, not milliseconds

    return `${String(hours)}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
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

        // Transcribe the audio file to ASS using OpenAI's Whisper model
        const assPath = await transcribeAudioToASS(audioPath, sceneNumber);
        console.log(`Transcription saved to: ${assPath}`);

        return { audioPath, assPath };
    } catch (error) {
        console.error("Error generating speech or transcription:", error);
        throw error;
    }
}

// Function to concatenate all individual videos into a single video
async function concatenateVideos(videoFiles, output) {
    console.log("Video files to concatenate:", videoFiles);
    console.log("Output Directory:", outputDir);

    const listFilePath = path.join(outputDir, 'video_list.txt');

    try {
        const fileContent = videoFiles.map(file => `file '${path.resolve(file)}'`).join('\n');
        fs.writeFileSync(listFilePath, fileContent);
        console.log(`Video list created at: ${listFilePath}`);

        // Debug: Read and log the contents of the list file
        const content = fs.readFileSync(listFilePath, 'utf-8');
        console.log(`Contents of video_list.txt:\n${content}`);
    } catch (error) {
        console.error("Error writing to video list file:", error);
        return; // Exit if there's an error
    }

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(listFilePath)
            .inputOptions('-f', 'concat') // Separate the options correctly
            .inputOptions('-safe', '0') // Separate the options correctly
            .outputOptions('-y') // Allow overwriting the output file
            .output(output)
            .on('end', () => {
                console.log(`Final video created: ${output}`);
                fs.unlinkSync(listFilePath); // Clean up the list file
                resolve();
            })
            .on('error', (err) => {
                console.error('Error concatenating videos:', err);
                reject(err);
            })
            .run();
    });
}


// Execute the main function with the provided prompt
generateTikTokVideo(prompt);
